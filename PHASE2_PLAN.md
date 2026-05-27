# ZeroProxy Phase 2 Plan: Service Worker JavaScript Rewriting

Status: implemented strict Phase 2 cutover for the default rewrite path. The parser/tooling direction is OXC: the Service Worker loads OXC parser WASM, `web/js-rewriter.js` performs AST-aware source rewriting from the OXC AST, the Go WASM HTML transformer calls that rewriter for inline scripts and event handlers, main-window dynamic `Function`/`eval`/string timer bodies execute under the runtime's virtual global scope, and unrewritable blob/data worker paths fail closed. Explicit compatibility passthrough exceptions are documented below.

Current-status note: this file is both the Phase 2 design record and a historical implementation checklist. Some hardening gates below have already been implemented, while browser API fidelity and adversarial compatibility coverage remain prototype-level; `ARCHITECTURE.md` is the canonical current-behavior document.

Current compatibility exception: `/__zp/api/script` still contains an explicit passthrough allowlist for selected third-party challenge/tag-manager scripts. That exception is not a strict-mode parse-failure fallback and must remain visible in documentation and tests before any high-assurance acceptance claim.

Phase 2 improves target-site compatibility by rewriting target JavaScript before execution. The main goal is to make ordinary target scripts observe a virtual target `location`/`window` model while preserving the ZeroProxy transport boundary.

This is a compatibility layer, not a claim of perfect browser-origin spoofing. Native browser objects such as `window.location` and the address bar remain browser-owned and proxy-origin-backed.

## Goals

- Run a JavaScript Rewriting Service inside the Service Worker.
- Implement the parser/rewriter as Rust compiled to WebAssembly, using OXC's optimized Rust parser and AST infrastructure.
- Rewrite target JavaScript so common reads/writes/calls involving `window`, `location`, `document`, `history`, iframe windows, `eval`, and `Function` pass through ZeroProxy runtime helpers.
- Keep the invariant that target network/navigation cannot escape the ZeroProxy path.
- Fail closed in strict mode: if JavaScript that must be rewritten cannot be parsed or transformed, do not execute the original source.
- Compatibility mode may keep `#k=<key>` in the real URL for share/link persistence, but every target-visible URL surface (`location`, `document.URL`, referrer, history state, message origins, storage keys, rewritten code helpers) must expose only the virtual target URL or a non-secret proxy route. This is a deliberate tradeoff from the earlier erase-key invariant and requires dedicated leak tests before it can be treated as high-assurance.
- Recursively apply storage, iframe, dynamic-rewrite, and DOM URL policies to every same-origin clean realm created by target code.
- Treat target Service Worker registration as unsupported and fully blocked. Do not add a virtual Service Worker compatibility layer in this plan.

## Non-goals

- Perfect native origin impersonation. In a standard same-origin proxy document, the browser's native `Location` object cannot be made indistinguishable from the target origin.
- Anti-bot stealth, CAPTCHA bypass, or native function string spoofing.
- Executing unparsed original target JavaScript as a compatibility fallback in strict mode.
- Server-side session state or server-side target JavaScript storage.


## Pre-Phase-2 hardening gates

Phase 2 must not start by assuming the rewriter will close every current gap. The existing Phase 0/1 boundary must first fail closed when rewriting is absent, late, or broken. The following gates are prerequisites for the Phase 2 implementation sequence.

This section is retained to explain the cutover sequence. Items marked with current-status notes are no longer open requirements in the current code, but their compatibility and verification implications still apply.

### P0: boundary hardening required before rewriter work

1. **Tighten target-response CSP**

   - Historical risk: earlier `web/zp-core.js` emitted `connect-src * blob: data: <proxy-ws-origin>` for Service Worker-constructed target responses.
   - Current status: `web/zp-core.js` and the server-side `zeroCSP` restrict `connect-src` to `'self'` plus the proxy WebSocket origin. Continued `script-src 'unsafe-eval'` / `wasm-unsafe-eval` is a documented Phase 2 compatibility exception for inline bootstrap and WASM/OXC initialization.
   - Why it matters: Phase 2 rewriting cannot be the only egress boundary. If a script source is missed, CSP must still provide defense-in-depth against direct native connections.
   - Required change:
     - Keep `ZP.fixedCSP()` aligned with the stricter server-side `zeroCSP`.
     - Keep target-response `script-src` free of `blob:` and `data:` script execution unless a future rewritten/contained path is explicitly designed and tested.
     - Re-evaluate `'unsafe-eval'` and `wasm-unsafe-eval` before any high-assurance acceptance claim.
   - Required tests:
     - Static policy test rejecting `connect-src *`.
     - Browser E2E fixture attempting direct external `fetch`, XHR, EventSource, and WebSocket egress.

2. **Preserve Service Worker message capabilities**

   - Current baseline: privileged target-document runtime messages carry a per-tab capability token generated by the Service Worker, passed through the self-removing `__ZP_BOOT` handoff, and kept closure-private by `runtime-prelude.js`.
   - Sensitive message types include `ZP_WS_OPEN`, `ZP_COOKIE_SET`, `ZP_HISTORY_UPDATE`, `ZP_BASE_UPDATE`, `ZP_SCROLL_UPDATE`, and `ZP_RESOLVE_ENTRY`.
   - Required change:
     - Preserve the per-tab runtime capability token when Phase 2 changes the boot pipeline.
     - Keep the token out of target-visible DOM and public globals.
     - Require that token on every runtime-originated `ZP_*` message.
     - Validate `event.source.id` against `clientContext` where possible.
     - Do not reintroduce `firstTab()` fallback for privileged message operations such as `openRuntimeStream`.
   - Required tests:
     - Forged page-level `postMessage` to the Service Worker is rejected.
     - Runtime WebSocket and cookie bridge messages still succeed with the valid token.

3. **Close blob/data script execution gaps**

   - Current risk: `URL.createObjectURL` wrapping is worker-oriented and MIME-dependent; blob/data scripts can also be introduced through DOM script loaders.
   - Required change:
     - Before the rewriter exists, block or neutralize target-created blob/data JavaScript execution paths that cannot be routed through the rewrite pipeline.
     - Include empty or unrecognized Blob MIME types in worker bootstrap handling, or wrap all target-created Blob URLs until Phase 2 can classify them.
     - Revisit `script-src blob: data:` together with the CSP gate above.
   - Required tests:
     - `new Worker(URL.createObjectURL(new Blob(["..."], { type: "" })))` is contained or blocked.
     - `<script src=blob:...>` and data URL script attempts do not execute unrewritten target code in strict mode.

4. **Contain dynamic JavaScript compilation in the foreground runtime**

   - Current risk: dynamic compilation paths are listed in this plan, but Phase 0 runtime does not yet block or rewrite all of them.
   - Required change:
     - In strict/pre-strict hardening mode, block, rewrite, or scope:
       - `eval` and indirect eval;
       - `Function`, `AsyncFunction`, `GeneratorFunction`, and `AsyncGeneratorFunction`;
       - constructor-constructor escapes such as `({}).constructor.constructor(...)`;
       - string `setTimeout` and `setInterval`;
       - `document.write` / `document.writeln`;
       - `outerHTML`, `template.innerHTML`, `Range.prototype.createContextualFragment`, and `DOMParser.prototype.parseFromString`;
       - inline event handler mutation APIs including `setAttribute`, `setAttributeNS`, `NamedNodeMap.setNamedItem`, `Attr.value`, and handler IDL setters.
   - Required tests:
     - `Function('return location.href')()` and constructor-constructor variants are rewritten or scoped.
     - String timers and runtime-created inline event handlers cannot execute against the native global scope.

### P1: reliability and correctness hardening before broad Phase 2 compatibility work

5. **Prepare inline event handler handling in the HTML transformer**

   - Current state: `internal/htmltx` rewrites URL-bearing attributes and `srcdoc`, but does not identify `on*` handler attributes.
   - Required change:
     - Add explicit detection for inline event handler attributes.
     - Preserve current behavior until the rewriter callback exists, but make the Phase 2 hook point explicit.
     - In strict mode, fail closed if an event handler body cannot be rewritten before browser compilation.
   - Required tests:
     - HTML transform test covering `onclick`, `onload`, `onerror`, and mixed-case handler attributes.
     - Phase 2 golden tests parsing handler bodies in event-handler grammar mode.

6. **Prove or harden `srcdoc` prelude ordering**

   - Current state: `srcdoc` content is protected by prefixing ZeroProxy scripts before target content.
   - Required change:
     - Add browser coverage proving that inline scripts and event handlers inside `srcdoc` cannot run before `runtime-prelude.js` installs containment.
     - If ordering is not reliable, block or rewrite executable `srcdoc` content until the Phase 2 rewriter handles it.
   - Required tests:
     - `iframe.srcdoc` with immediate inline script and `body onload` cannot reach native WebRTC/WebSocket or native `location` before containment.

7. **Cap or stream request/upload bodies**

   - Current state: request bodies are buffered through Service Worker/WASM bridges.
   - Required change:
     - Short term: enforce an explicit maximum body size and return a safe ZeroProxy error for oversized uploads.
     - Medium term: implement `ReadableStream` request body bridging instead of full buffering.
   - Required tests:
     - Oversized POST/upload returns a safe error, not OOM or process instability.
     - Non-oversized POST body survives the Service Worker -> WASM -> target path.

8. **Define redirect body replay semantics**

   - Current risk: 307/308 redirects preserve method and body, but non-replayable bodies cannot be resent safely after the first attempt consumes them.
   - Required change:
     - For replayable small bodies, buffer once and replay across 307/308 redirects.
     - For non-replayable or oversized bodies, fail closed with a safe error.
     - Do not silently send an empty or partial body after redirect.
   - Required tests:
     - 307/308 POST redirect with a small body reaches the redirected target intact.
     - Non-replayable body redirect fails safely.

9. **Make relay cancellation immediate and bidirectional**

   - Current risk: relay goroutines using `io.Copy` may stay blocked after request/context cancellation.
   - Required change:
     - On context cancellation or one relay direction finishing, close both stream endpoints to interrupt blocked reads/writes.
     - Prefer a context-aware relay loop or reuse an existing relay helper with explicit close semantics.
   - Required tests:
     - Closing the browser page or WebSocket pipe tears down both yamux/Tor relay directions without goroutine leaks.

### P2: coverage and fidelity improvements that should accompany Phase 2

10. **Expand direct-egress E2E coverage**

    - Required browser fixtures:
      - Direct external `fetch`.
      - `XMLHttpRequest`.
      - `EventSource`.
      - Native WebSocket attempts.
    - Each fixture must prove the request is blocked or routed through ZeroProxy, never through an unclassified native path.

11. **Improve WebSocket wrapper fidelity**

    - Current minimal wrapper is enough for basic echo but not browser-compatible enough for broad sites.
    - Required improvements:
      - Preserve negotiated subprotocol where available.
      - Improve close code/reason and error sequencing.
      - Cover binary `ArrayBuffer` / `Blob` message behavior.
      - Add conformance-lite E2E tests for open, message, binary, close, protocol, and error paths.

12. **Clarify HTML tokenizer error policy**

    - Current doc comments imply parser-recoverable markup is emitted, while tokenizer errors currently fail.
    - Required change:
      - Decide and document whether malformed HTML is strict fail-closed or recovery-oriented.
      - Align the behavior with Phase 2 strict rewrite failure policy.
    - Required tests:
      - Malformed but common HTML either recovers predictably or produces a safe `MALFORMED_HTML` error document without partial unsafe execution.

13. **Validate share URL schemes in the Go share-url package** — implemented in current code

    - Historical risk: callers usually validated `http`/`https`, but `internal/shareurl.New()` itself only encrypted a string.
    - Current status: `internal/shareurl.New()` / `NewWithRand()` reject empty, malformed, hostless, and non-HTTP(S) targets.
    - Required invariant:
      - Continue rejecting `ws:`, `wss:`, `javascript:`, `data:`, and empty or malformed URLs in the Go share-url package, not only at call sites.

## Design constraint: why rewriting is necessary but not sufficient

`window.location` cannot be fully virtualized by descriptor patching alone:

- Chromium exposes many `Location` members as non-configurable own accessors on the native `location` object.
- `window.location` itself is non-configurable.
- `Location.prototype.assign` may be absent while `location.assign` exists as an own native method.
- Clean realms such as newly-created iframes can expose native objects before asynchronous patching runs.

Therefore Phase 2 treats native descriptor patching as best-effort and moves compatibility to source rewriting plus a runtime membrane.

A key rewrite such as:

```js
window[__zp_access('loca' + 'tion')]
```

is not enough because the expression still reads `window['location']` and returns the real native `Location` object. The rewrite must route the access itself:

```js
window['loca' + 'tion']
// becomes
__zp_get(window, 'loca' + 'tion')
```

Writes and calls need their own transforms:

```js
location.href = url        // -> __zp_set(location, 'href', url) or __zp_nav_assign(url)
window.location = url      // -> __zp_nav_assign(url)
location.assign(url)       // -> __zp_nav_assign(url)
location.replace(url)      // -> __zp_nav_replace(url)
document.defaultView       // -> __zp_get(document, 'defaultView')
iframe.contentWindow       // -> __zp_get(iframe, 'contentWindow')
```

## Architecture

```text
Target response
  -> Service Worker classifier
  -> Go WASM kernel transport
  -> HTTP/HTML/header policy
  -> JavaScript Rewriting Service in Service Worker
       -> Rust + OXC parser compiled to WASM
       -> AST rewrite
       -> strict/audit diagnostics
  -> Browser executes rewritten target code
       -> runtime membrane helpers
       -> Service Worker runtime APIs
       -> Go WASM transport
```

### Components

| Component | Location | Responsibility |
|---|---|---|
| Rewriter WASM | new Rust crate, built to a web/service-worker-compatible WASM artifact | Parse JavaScript with OXC, perform AST transforms, return rewritten source and diagnostics. |
| Service Worker Rewriting Service | `web/sw.js` plus a new internal module/glue asset | Load the rewriter WASM, decide when to rewrite, cache transformed results, enforce fail-closed policy. |
| Runtime membrane | `web/runtime-prelude.js` | Provide `__zp_get`, `__zp_set`, `__zp_call`, `__zp_construct`, virtual `Location`, virtual window wrappers, and navigation helpers used by rewritten code. |
| Foreground synchronous rewriter | `web/runtime-prelude.js` plus the same OXC WASM artifact or a smaller dynamic-code rewriter artifact | Preinitialize a closure-private rewriter in the target page for synchronous `eval`, `Function`, and string timer rewriting. |
| HTML integration | `internal/htmltx` and `cmd/wasm-kernel` | Rewrite inline scripts and inline event handlers before the browser compiles them. |
| External script pipeline | `web/sw.js` | Rewrite `script`, `module`, worker, and imported script responses before returning them to the browser. |
| Recursive storage/iframe policy | `web/runtime-prelude.js`, `web/worker-prelude.js` | Install storage facades and containment hooks into every accessible same-origin window, iframe, `srcdoc`, popup, and worker realm before target code can use native storage or network APIs. |
| Upload navigation bridge | `web/runtime-prelude.js`, `web/sw.js`, Go WASM kernel | Store form submission bodies in client-owned transient storage, activate a submit/navigation route, dispatch the target request when the submitted page loads, and return the transformed response through the Service Worker document pipeline. |
| Foreground in-place rewriter | `web/runtime-prelude.js`, OXC foreground bundle | Synchronously rewrite dynamic code and DOM mutations in the target realm before browser compilation or immediately replace inert placeholders with rewritten code. |

## Compatibility uplift plan

This plan replaces selected explicit blockers with compatibility layers only when the replacement still preserves the ZeroProxy transport and rewriting boundary. Native target network, raw target JavaScript fallback, native target Service Workers, and unclassified Service Worker request fallback remain forbidden.

### Recursive storage and iframe containment

Storage and realm hooks must be installed recursively, not only on the initial top-level document:

1. Maintain a realm registry keyed by `Window`/`WorkerGlobalScope` object identity. Installing hooks must be idempotent and must not allocate duplicate facades for the same realm.
2. On every accessible iframe, frame, popup, `srcdoc`, `about:blank`, and dynamically inserted clean realm, synchronously install:
   - virtual `location`/`history` helpers;
   - `fetch`, XHR, EventSource, WebSocket, and `sendBeacon` wrappers where the realm supports them;
   - `localStorage`, `sessionStorage`, IndexedDB, CacheStorage, cookie, and BroadcastChannel namespace facades;
   - Worker/SharedWorker/importScripts/worklet loaders;
   - high-risk device/network blockers or denied shims.
3. Storage namespace keys must include tab id, top-level route key, virtual origin, storage type, and realm role. Child frames with the same virtual origin may share origin-scoped `localStorage`/IndexedDB/CacheStorage, while `sessionStorage` remains top-level browsing-context scoped unless browser semantics require a cloned opener snapshot.
4. `storage` events must be synthesized only to compatible same-virtual-origin realms in the same tab namespace. Events must never cross tabs, target origins, or route keys.
5. `iframe.contentWindow`, `contentDocument`, `document.defaultView`, popup `opener`, `parent`, `top`, and `frames[]` access must always return wrapped objects or synchronously install containment before returning the native object.
6. `srcdoc` and initial `about:blank` frames must receive the runtime prelude and storage hooks before any inline script, event handler, or dynamic HTML sink can execute.

Acceptance tests:

- nested iframe, `srcdoc`, `about:blank`, and popup fixtures cannot access native storage or native network constructors before containment;
- same-virtual-origin frames observe shared `localStorage` updates and storage events, while cross-virtual-origin frames do not;
- `sessionStorage` clone/isolation behavior matches the documented top-level browsing-context policy;
- IndexedDB and CacheStorage names are prefixed or encrypted consistently across nested realms.

### Form body upload and document navigation bridge

Non-GET form submissions must stop using `document.write` as the primary compatibility path. Use a client-owned pending-submission record and let the Service Worker answer the submitted document navigation:

1. On submit, the runtime serializes the form body according to the browser-selected encoding:
   - `application/x-www-form-urlencoded`;
   - `multipart/form-data`, including file metadata and Blob/File body references;
   - `text/plain`.
2. Store the body in transient client-side storage under a random pending submission id. Small bodies may live in memory; larger bodies use IndexedDB/OPFS-style chunk storage with an explicit total size cap and per-chunk integrity metadata.
3. Activate a submit route such as `/p/<route>#k=<key>&zp_submit=<id>` or the future active route equivalent. The real URL may keep `#k=<key>` in compatibility mode, but target-visible runtime URL surfaces must mask both key and submission id.
4. On the submitted page load, the Service Worker consumes the pending submission exactly once, reconstructs the target request with original method, headers, body, referrer policy, and virtual origin metadata, then calls the WASM kernel.
5. The target response returns through the normal document pipeline: redirect handling, cookie jar update, header policy, HTML transform, script rewrite, runtime prelude injection, and CSP.
6. Pending submission records must be deleted after success, safe error, cancellation, expiry, or tab close. A reload may replay only if the body is explicitly marked replayable and still within the pending record lifetime.

Acceptance tests:

- GET, urlencoded POST, multipart file POST, and text/plain POST navigate through the Service Worker document path and receive transformed HTML;
- 307/308 redirects preserve replayable bodies exactly once and fail safely for expired/non-replayable bodies;
- oversized uploads return `REQUEST_BODY_TOO_LARGE` or a documented safe upload error without partial target requests;
- pending submission ids and `#k` fragments are not observable through virtual `location`, `document.URL`, form action getters, history state, or message events.

### Target Service Worker policy

Target-controlled Service Workers remain fully blocked:

- `navigator.serviceWorker.register`, `getRegistration`, `getRegistrations`, `ready`, and controller mutation surfaces must expose a stable unsupported/empty state rather than reaching the browser's real Service Worker registry.
- No virtual target Service Worker event loop is added in this plan. CacheStorage compatibility comes from the recursive storage facade, not from executing target Service Worker scripts.
- Registration attempts should reject with a browser-shaped `SecurityError` or `NotSupportedError` and emit a ZeroProxy diagnostic.

Acceptance tests:

- target registration scripts cannot install, activate, claim clients, intercept requests, or persist target-controlled Service Worker state;
- feature detection sees a stable blocked state and does not gain access to `navigator.serviceWorker.controller` for the proxy origin.

### Foreground synchronous in-place rewriter

The foreground runtime must include a synchronous parser-backed rewriter for every dynamic JavaScript source that cannot wait for an asynchronous Service Worker round trip:

1. Preinitialize a closure-private OXC foreground bundle, or a smaller ABI-compatible parser/rewriter, before any target script executes.
2. Expose no public `window.__zp_rewrite` downgrade switch. Target code may only reach rewritten behavior through patched browser APIs.
3. For `eval`, indirect eval, `Function`, constructor-constructor escapes, string timers, and inline event handler setters, parse and rewrite synchronously in the correct grammar mode, then execute the rewritten code in the virtual global membrane.
4. For dynamic DOM compilation sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `template.innerHTML`, `DOMParser.parseFromString`, `Range.createContextualFragment`, and `iframe.srcdoc`), parse to an inert fragment, rewrite or launder URL/script/event-bearing nodes in place, then insert only the rewritten fragment.
5. For already-created nodes observed by mutation hooks, immediately make executable nodes inert (`type="application/x-zeroproxy-pending"` or `about:blank` placeholder), synchronously rewrite/launder, then restore executable state only after the replacement source is safe.
6. If synchronous rewriting fails, strict mode blocks the source; compat mode may keep the node inert and report a diagnostic, but must never execute original target JavaScript outside the membrane.

Acceptance tests:

- dynamic event handlers, `javascript:` click handlers selected for compatibility, string timers, `Function`, and constructor-constructor code observe virtual `location` and routed network APIs;
- dynamic script/data/blob insertion either rewrites through the in-place rewriter or remains inert;
- no target-visible global can invoke or disable the rewriter directly.

### Persistent `#k=<key>` compatibility mode

Compatibility mode keeps `#k=<key>` in the browser URL to preserve shareability and reload behavior. This is weaker than the previous erase-fragment invariant and is accepted only with the following containment rules:

1. Native fragments are never sent to HTTP servers, but target scripts must still be prevented from reading the raw key through virtualized browser APIs.
2. The runtime and rewriter must mask `location.href`, `location.hash`, `document.URL`, `document.documentURI`, anchor/form URL getters, history entries, referrers, message origins, storage keys, and error pages so they expose the virtual target URL or a non-secret proxy route.
3. The Service Worker may use the real fragment only during activation and pending form-submission recovery. It must not copy the raw key into logs, CacheStorage, IndexedDB records visible to target facades, diagnostics, or message payloads.
4. Strict/high-assurance mode may still choose the older erase-fragment policy. If compatibility mode becomes the default, leak tests become a release gate.

Acceptance tests:

- target code using direct globals, rewritten globals, `Reflect.get`, descriptors, dynamic code, iframes, popups, postMessage, and DOM URL getters cannot observe the raw `#k=<key>`;
- copy/paste/share/reload of the real URL remains functional when the user intentionally keeps the fragment.

### DOM URL observer hardening

Runtime DOM observation must continuously enforce URL policy for both parser-created and script-created elements:

1. Observe `href`, `src`, `srcdoc`, `action`, `formaction`, `integrity`, `type`, `rel`, `target`, and relevant namespace attributes across the whole document and every contained iframe realm.
2. For `<a>` and `<area>`, preserve author-visible `href` when possible, but store the canonical target URL in hidden runtime metadata and ensure click-time navigation resolves through ZeroProxy.
3. For script, iframe, frame, worker/worklet module, preload-like link, manifest, form, and submitter URL attributes, synchronously launder, rewrite, or block according to the same policy as the tokenizer transform.
4. If target code mutates an already-laundered attribute back to a native URL, the observer must detect and reapply policy before the browser can fetch or navigate. Where the browser may fetch immediately, setter hooks must perform synchronous enforcement before the mutation reaches the DOM.
5. Mutation handling must be reentrant-safe and must not create infinite observer loops.

Acceptance tests:

- GTM-style detached script insertion, anchor `href` mutation after insertion, nested iframe DOM mutation, SVG/xlink URL attributes, and submitter `formaction` changes all remain routed through ZeroProxy;
- preload/prefetch/preconnect/dns-prefetch/prerender/manifest links are removed or converted before native network access.

## Service Worker Rewriting Service

The Service Worker owns the rewrite decision because it already classifies every controlled request and has the target context.

### Initialization

- Add a rewrite readiness stage separate from Go kernel transport readiness:

```text
REWRITE_UNINITIALIZED -> REWRITE_LOADING -> REWRITE_READY -> REWRITE_FAILED
```

- Load the OXC rewriter WASM as an internal asset, for example:

```text
/__zp/js-rewriter.wasm
/__zp/js-rewriter.js
```

- Rewriter initialization must not depend on target network access.
- If strict mode is enabled and the rewriter cannot initialize, target script execution must be blocked with `REALM_INJECTION_FAILURE`.

### Rewrite inputs

The service accepts:

```ts
type RewriteInput = {
  source: string;
  url: string;
  baseUrl: string;
  targetUrl: string;
  scriptKind: 'classic' | 'module' | 'event-handler' | 'eval' | 'function' | 'worker';
  strict: boolean;
};
```

The service returns:

```ts
type RewriteOutput = {
  ok: true;
  code: string;
  dependencies?: string[];
  diagnostics: RewriteDiagnostic[];
} | {
  ok: false;
  errorCode: 'PARSE_FAILED' | 'UNSUPPORTED_SYNTAX' | 'REWRITE_FAILED';
  diagnostics: RewriteDiagnostic[];
};
```

## JavaScript sources that must be covered

Phase 2 is not accepted until every target-controlled JavaScript source is either rewritten or blocked:

- External classic scripts: `<script src>`.
- External module scripts: `<script type="module" src>`.
- Inline classic scripts.
- Inline module scripts.
- Inline event handlers: `onclick`, `onload`, etc.
- `javascript:` URLs, which should remain blocked unless a safe rewrite-and-execute policy is explicitly added.
- Worker scripts: `new Worker()`, `new SharedWorker()`, `importScripts()`.
- Blob/data worker scripts.
- Dynamic import targets where the browser routes the module fetch through the Service Worker.
- String timers: `setTimeout("...")`, `setInterval("...")`.
- Dynamic code: `eval`, indirect eval, `new Function`, and constructor-constructor patterns.

## Dynamic code policy

Synchronous dynamic code is the hardest part.

A Service Worker API is asynchronous from the page's point of view. Direct `eval(code)` and `new Function(code)` are synchronous JavaScript APIs, so a page cannot synchronously ask the Service Worker to rewrite code without changing semantics.

Phase 2 strict policy:

- `eval`, indirect eval, `new Function`, and constructor-constructor access to `Function` must execute under the same virtual global policy as rewritten scripts.
- `setTimeout(string)` and `setInterval(string)` must compile the string handler under that virtual global policy before scheduling.
- Dynamic code still fails closed when the foreground runtime cannot contain it synchronously; blob/data worker scripts remain blocked unless a safe worker rewrite path is available.

## Foreground synchronous dynamic containment

Dynamic code APIs are synchronous. A Service Worker API is asynchronous from the page's point of view, so the controlled page must contain and rewrite these APIs before target scripts run. The foreground runtime therefore owns a parser-backed synchronous in-place rewriter for `eval`, `Function`, constructor-constructor escapes, string timers, inline event handlers, and dynamic DOM compilation sinks. It rewrites executable sources before browser compilation; if a node is already present, it first makes that node inert, rewrites or launders it, then restores only the safe replacement.

```text
runtime-prelude.js
  -> create closure-private virtual global scope
  -> patch eval / Function / timers / dynamic HTML compilation APIs
  -> compile dynamic bodies under that virtual scope
  -> dynamic code observes virtual location/window and patched transport APIs
```

Requirements:

- Dynamic containment hooks must initialize before any target-controlled script can execute. If a selected mode requires a parser-backed foreground rewriter and initialization fails, target script execution fails closed with `REALM_INJECTION_FAILURE`.
- The foreground containment machinery must not be exposed as `window.__zp_rewrite` or any other target-visible global. Target code may call patched dynamic-code APIs, but must not be able to invoke, configure, or downgrade the containment path directly.
- The foreground and Service Worker rewriters must use the same transformer version and helper ABI. The runtime must compare an embedded transformer version/hash and fail closed on mismatch.
- The page-local path owns synchronous dynamic-code and DOM in-place rewriting. The Service Worker remains the canonical pipeline for target network requests, external script responses, form-submission document responses, caching, diagnostics, and strict-mode policy decisions.
- Foreground dynamic containment must never expose share keys, transport secrets, HttpOnly cookies, or Service Worker state to target code.
- CSP must explicitly allow only the minimum needed for foreground dynamic execution. Any continued use of `'unsafe-eval'` or `wasm-unsafe-eval` must be documented as a compatibility requirement and revisited after dynamic containment is complete.

Dynamic execution hooks required in the foreground runtime:

- `eval(source)` and indirect eval-like calls that can be observed after static rewrite.
- `Function(...args, body)`, plus `AsyncFunction`, `GeneratorFunction`, and `AsyncGeneratorFunction` constructors.
- Constructor escape paths such as `({}).constructor.constructor(...)` and `fn.constructor(...)`.
- String timers: `setTimeout("code", ...)` and `setInterval("code", ...)`.
- Inline event handler mutation APIs: `Element.prototype.setAttribute`, `setAttributeNS`, `Attr.value`, `NamedNodeMap.setNamedItem`, and handler IDL setters where browsers compile string handlers.
- Dynamic HTML compilation APIs that can introduce event handlers or scripts: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `document.writeln`, `Range.prototype.createContextualFragment`, `DOMParser.prototype.parseFromString`, `iframe.srcdoc`, and `template.innerHTML`.
- Blob/data script creation paths: `URL.createObjectURL(new Blob([...], { type: 'text/javascript' }))`, worker blob URLs, and data URL workers.
- Worker and worklet dynamic loaders: `Worker`, `SharedWorker`, `importScripts`, and `addModule`.

String replacement is explicitly forbidden for this layer. A patch like `code.replace(/location/g, ...)` corrupts string literals, object keys, comments, locally-bound identifiers, and unrelated words. Current runtime containment compiles the original body under a virtual scope instead of text-replacing it. If parser-backed dynamic rewriting is used, every executable string must be parsed in the correct grammar mode: full script, module, function body, event handler body, or timer/eval program. Rewrite failure in strict mode means block, not execute original source outside containment.

Direct eval preservation rule:

Static source rewriting should prefer this shape for direct eval:

```js
eval(code)
// becomes, while keeping the direct eval callee:
eval(__zp_rewrite_dynamic(code, 'eval'))
```

Replacing `eval` with a wrapper function changes direct-eval lexical-scope semantics and is allowed only in compatibility mode with diagnostics, never as the strict-mode proof path.


`new Function(args..., body)` is easier because it already creates global-scope code. The foreground rewriter rewrites `body` before calling the native `Function` constructor.

Constructor escapes must also be routed through the same policy:

```js
({}).constructor.constructor('return location.href')()
```

Rewritten property access and runtime membrane helpers must prevent target code from obtaining the native `Function` constructor as an unmediated escape hatch.


## AST rewrite scope

The OXC transform must use scope-aware analysis. It must not rewrite locally-bound variables named `location`, `window`, `document`, etc.

### Global identifier access

Rewrite unresolved global identifiers:

```js
location          // -> __zp_get(globalThis, 'location')
window            // -> __zp_get(globalThis, 'window')
document          // -> __zp_get(globalThis, 'document')
history           // -> __zp_get(globalThis, 'history')
top               // -> __zp_get(globalThis, 'top')
parent            // -> __zp_get(globalThis, 'parent')
opener            // -> __zp_get(globalThis, 'opener')
frames            // -> __zp_get(globalThis, 'frames')
```

### Member reads

```js
obj.location                  // -> __zp_get(obj, 'location')
obj['location']               // -> __zp_get(obj, 'location')
obj['loca' + 'tion']          // -> __zp_get(obj, 'loca' + 'tion')
document.defaultView          // -> __zp_get(document, 'defaultView')
iframe.contentWindow          // -> __zp_get(iframe, 'contentWindow')
iframe.contentDocument        // -> __zp_get(iframe, 'contentDocument')
```

### Writes and updates

```js
location.href = u             // -> __zp_set(__zp_get(globalThis, 'location'), 'href', u)
window.location = u           // -> __zp_set(window, 'location', u)
obj.location.href += '#x'     // -> helper preserving compound assignment semantics
++location.hash               // -> block or helper; native semantics are not useful here
```

Compound assignments and update expressions need temporary variables to preserve evaluation order and side effects.

### Calls

```js
location.assign(u)            // -> __zp_call(__zp_get(globalThis, 'location'), 'assign', [u])
location.replace(u)           // -> __zp_call(__zp_get(globalThis, 'location'), 'replace', [u])
window.open(u)                // -> __zp_call(window, 'open', [u])
Reflect.get(window, 'location') // -> __zp_reflect_get(window, 'location')
```

Method calls must preserve `this` binding.

### Destructuring and aliases

```js
const { location } = window;
```

must become a safe binding initialized from the helper, not a native object leak.

Aliases must remain safe:

```js
const w = window;
w.location.href;
```

At minimum, any member access on a possibly-window-like object must go through the helper.

## Runtime membrane helpers

The rewritten code calls a small stable runtime API injected before target code:

```ts
__zp_get(base, prop): unknown
__zp_set(base, prop, value): boolean
__zp_call(base, prop, args): unknown
__zp_construct(ctor, args): unknown
__zp_has(base, prop): boolean
__zp_getOwnPropertyDescriptor(base, prop): PropertyDescriptor | undefined
__zp_ownKeys(base): PropertyKey[]
__zp_wrapWindow(win): object
__zp_wrapDocument(doc): object
__zp_virtualLocation: LocationLike
__zp_nav_assign(url): void
__zp_nav_replace(url): void
```

Rules:

- Window-like objects return wrapped window facades.
- Document-like objects return wrapped document facades.
- Location reads return the virtual target URL state.
- Location writes route through encrypted `/p` navigation.
- Iframe `contentWindow` and `contentDocument` never expose clean native realms directly.
- Unknown objects should use native behavior unless the property is dangerous.

## Inline HTML integration

Inline scripts and event attributes must be rewritten before browser parsing compiles them.

Preferred implementation path:

1. Service Worker loads the OXC rewriter WASM and exposes a synchronous `__zp_rewrite_js(source, options)` function in the Service Worker global.
2. Go WASM HTML transformation calls that function via `syscall/js` while tokenizing target HTML.
3. `internal/htmltx` rewrites:
   - script text for classic scripts;
   - script text for module scripts;
   - inline event handler attribute bodies;
   - safe inline bootstrap snippets only if they are target-controlled.
4. If rewriting fails in strict mode, the HTML transform emits a safe error document or removes the offending script with a policy violation diagnostic.

This avoids executing raw inline target code before rewriting.

## External script rewriting

For script responses, `web/sw.js` wraps the target `Response`:

1. Identify script requests using `request.destination === 'script'`, `Sec-Fetch-Dest`, module metadata when available, and response `Content-Type`.
2. Read the script body as text. OXC requires a full source string; script bodies are allowed to be buffered even though non-script response bodies should keep streaming.
3. Rewrite with OXC.
4. Return a new `Response` with rewritten source and constructor-safe headers.
5. Strip or regenerate source maps unless source-map rewriting is implemented.

Internal ZeroProxy assets must never be passed through the target rewriter.

## Caching

Initial strict implementation may use memory-only caching:

```text
cache key = SHA-256(transformerVersion || scriptKind || targetURL || sourceBytes)
```

Later, CacheStorage or IndexedDB may persist transformed code. Persistent caches must not store share keys or transport secrets. If persisted state contains target URL metadata, it must follow the client-side encrypted state policy.

## Modes

| Mode | Behavior |
|---|---|
| `off` | No rewriting. Current Phase 0 behavior. |
| `audit` | Rewrite and report diagnostics, but do not execute rewritten code. Useful only for development. |
| `compat` | Rewrite when possible; use the foreground synchronous rewriter for dynamic code when initialized; block the most dangerous dynamic-code paths otherwise; allow selected parse failures only for scripts proven not to need location/window mediation. |
| `strict` | Every target-controlled script source must be rewritten or blocked. Dynamic code requires the approved foreground synchronous rewriter or is blocked. No original target JavaScript fallback. |

Phase 2 acceptance targets `strict` for security tests and `compat` for broad-site evaluation.

## Security invariants

- No rewrite failure may cause a native target network fallback.
- In compatibility mode the real browser URL may retain `#k=<key>`, but no target-visible virtual URL surface may expose the raw key or pending submission ids. Strict/high-assurance deployments may keep the older erase-fragment policy.
- No target script may receive the Go kernel transport secrets, stream isolation key material, or HttpOnly cookie state.
- Rewritten navigation must remain on proxy-origin `/p` routes unless a later phase intentionally reintroduces `/v` active routes.
- CSP remains defense-in-depth; Service Worker classification and the transport kernel remain the egress boundary.
- Original source is never executed in strict mode when rewriting is required.
- Target-controlled Service Workers remain fully blocked; no compatibility layer may execute target Service Worker scripts or let them claim proxy-origin clients.
- Storage, iframe, popup, worker, and dynamic DOM policies must apply recursively to every accessible same-origin realm before target code can use native storage, network, or executable-code compilation paths.

## Test plan

### Rust transformer tests

Golden tests for:

- `location.href`, `location.assign`, `window.location`, `globalThis.location`.
- `window['location']`, `window['loca' + 'tion']`.
- `document.defaultView.location`.
- `iframe.contentWindow.fetch`, `iframe.contentWindow.WebSocket`, `iframe.contentWindow.location`.
- destructuring: `const { location } = window`.
- aliasing: `const w = window; w.location`.
- optional chaining: `window?.location?.href`.
- compound assignments and update expressions.
- `Reflect.get`, `Object.getOwnPropertyDescriptor`, `Object.defineProperty` for dangerous properties.
- `eval`, indirect eval, `new Function`, and constructor-constructor patterns.
- String timers and event handler bodies parse in the correct grammar mode.
- module syntax, dynamic import syntax, top-level await.

### JavaScript/runtime tests

- Runtime membrane returns virtual target URL fields.
- Location writes call encrypted proxy navigation helpers.
- Wrapped iframe windows do not expose native clean-realm network APIs.
- Method calls preserve `this` where native compatibility requires it.
- `setAttribute('onclick', ...)`, `innerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser.parseFromString`, and `Range.createContextualFragment` rewrite or neutralize executable handler bodies before they compile.
- Foreground dynamic-code rewriter is closure-private, preinitialized before target scripts, and version-matched with the Service Worker rewriter.
- Patched `eval`, indirect eval, `Function`, `setTimeout(string)`, and `setInterval(string)` either rewrite synchronously or block in strict mode.
- Recursive storage facades install into nested iframes, `srcdoc`, `about:blank`, popups, and workers without leaking native storage or crossing virtual origins.
- Foreground in-place rewriting makes observed executable DOM nodes inert before rewriting and never executes original dynamic source after a rewrite failure.
- DOM URL observers reapply policy to `href`, `src`, `srcdoc`, `action`, `formaction`, namespace URL attributes, `rel`, `target`, `integrity`, and `type` mutations without infinite observer loops.
- Target Service Worker APIs expose a stable blocked/empty state and never reach the browser's real proxy-origin Service Worker registry.

### Browser E2E tests

- `gosuda.org` home cards navigate through `/p` routes.
- `gosuda.org` language dropdown button navigation stays on proxy-origin `/p` routes.
- A test page reading `location.href`, `window.location.href`, `document.URL`, and `document.defaultView.location.href` observes the virtual target URL from rewritten code.
- A hostile test page using `window['loca' + 'tion']`, `Reflect.get(window, 'location')`, iframe clean realms, and `Function('return location.href')` is rewritten or blocked according to strict mode.
- No tested path changes the top-level URL to the target origin.
- Direct external `fetch`, XHR, EventSource, and native WebSocket attempts are blocked or routed through ZeroProxy; none use an unclassified native path.
- Blob/data worker and script fixtures are contained, rewritten, or blocked.
- `srcdoc` inline scripts and event handlers cannot execute before iframe containment.
- Request/upload size limits, 307/308 redirect replay behavior, and relay cancellation semantics are covered by integration tests.
- Non-GET form submissions persist pending bodies in client-owned transient storage, activate a submitted document route, consume the pending body exactly once in the Service Worker, and return the transformed target response through the normal document pipeline.
- Multipart file uploads, urlencoded POST, text/plain POST, oversized upload failure, expiry/cancellation cleanup, and 307/308 replay behavior are covered.
- Persistent `#k=<key>` compatibility mode keeps reload/share behavior while hostile code in nested frames, popups, dynamic code, descriptors, and DOM URL getters cannot observe the raw key.
- DOM URL observer fixtures cover anchor `href` mutation after insertion, SVG/xlink URL attributes, submitter `formaction` mutation, nested iframe mutation, and preload-like link insertion.

### Performance tests

- Measure parser/transform latency by script size buckets: 10 KB, 100 KB, 1 MB, 5 MB.
- Measure first-page-load overhead with and without memory cache.
- Ensure non-script response streaming is not regressed.

## Implementation sequence

Before starting item 1, complete the P0 hardening gates above. P1 gates should be completed before broad-site compatibility evaluation, and P2 gates should be tracked as required coverage for Phase 2 acceptance.

1. Add rewriter mode configuration and diagnostics plumbing.
2. Vendor OXC parser WASM assets and expose a strict Service Worker rewriter service.
3. Add the ABI-compatible foreground synchronous in-place rewriter bundle and verify version/hash parity with the Service Worker rewriter.
4. Add runtime membrane helpers used by rewritten code.
5. Patch `eval`, indirect eval, `Function`, string timers, constructor-constructor escapes, inline event handler setters, and dynamic HTML compilation APIs to use the foreground in-place rewriter or remain inert.
6. Replace regex-only dynamic HTML handling with inert-fragment DOM walking that rewrites/launders scripts, event handlers, URL attributes, and `srcdoc` before insertion.
7. Extend recursive containment to iframes, `srcdoc`, `about:blank`, popups, workers, and worklets; install storage facades and network wrappers idempotently in every accessible realm.
8. Harden DOM URL observers and synchronous setters for `href`, `src`, `srcdoc`, `action`, `formaction`, namespace URL attributes, `rel`, `target`, `integrity`, and `type`.
9. Implement the form-submission pending-body store, submitted-document route activation, one-shot Service Worker body consumption, and transformed response return path.
10. Keep target Service Worker registration and controller APIs fully blocked with browser-shaped unsupported/empty results.
11. Rewrite external classic scripts in the Service Worker.
12. Add module script support.
13. Add Go HTML transform callback for inline scripts and inline event handlers.
14. Add worker/importScripts/blob/data script rewriting where synchronous or bootstrap-contained rewriting is available; otherwise keep sources inert/blocked.
15. Add browser E2E tests and hostile escape fixtures for recursive storage/iframe containment, pending form uploads, persistent-fragment masking, and DOM observer hardening.
16. Tighten CSP once compatibility data is available.
17. Re-run and update the pre-Phase-2 hardening gates; no P0 item may remain open for strict mode.

## Acceptance criteria

Phase 2 is accepted when:

- The Service Worker initializes the OXC parser/WASM rewriting service before target script execution in strict mode.
- External scripts, inline scripts, event handlers, and worker scripts are rewritten or blocked.
- Dynamic code execution is rewritten synchronously by an approved page-local path or blocked.
- Runtime-created event handlers and dynamic HTML paths (`setAttribute`, `innerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`, `Range`) are rewritten before browser compilation or neutralized.
- Foreground dynamic-code rewriting is initialized before target scripts, is not target-visible as a public API, and version-matches the Service Worker rewriter.
- Rewritten code observes virtual location values through the runtime membrane in the required browser E2E tests.
- `gosuda.org` click navigation and language dropdown navigation remain on proxy-origin `/p` routes.
- Hostile tests for `window['loca' + 'tion']`, `Reflect.get`, iframe clean realms, and constructor-constructor dynamic code do not expose a native direct-egress path.
- All strict-mode rewrite failures produce safe ZeroProxy errors instead of executing original target code.
- P0 hardening gates are complete: strict CSP, Service Worker message capabilities, blob/data script handling, and fail-closed dynamic compilation paths.
- Recursive storage and iframe containment are installed before target code can observe native clean-realm storage, network, or executable-code APIs.
- Non-GET form submissions use the pending-body Service Worker document navigation bridge and no longer depend on `document.write` for the primary response path.
- Target Service Worker registration, controller, and registration lookup APIs are fully blocked and cannot install or execute target Service Worker scripts.
- Persistent `#k=<key>` compatibility mode passes leak tests for target-visible URL surfaces, or strict/high-assurance mode keeps the erase-fragment policy enabled.
- DOM URL observers and synchronous setters keep parser-created and script-created anchors, forms, iframes, scripts, and preload-like links routed through ZeroProxy after mutation.
