# ZeroProxy Phase 2 Plan: Service Worker JavaScript Rewriting

Status: proposed implementation plan.

Phase 2 improves target-site compatibility by rewriting target JavaScript before execution. The main goal is to make ordinary target scripts observe a virtual target `location`/`window` model while preserving the ZeroProxy transport boundary.

This is a compatibility layer, not a claim of perfect browser-origin spoofing. Native browser objects such as `window.location` and the address bar remain browser-owned and proxy-origin-backed.

## Goals

- Run a JavaScript Rewriting Service inside the Service Worker.
- Implement the parser/rewriter as Rust compiled to WebAssembly, using SWC's optimized Rust parser and AST infrastructure.
- Rewrite target JavaScript so common reads/writes/calls involving `window`, `location`, `document`, `history`, iframe windows, `eval`, and `Function` pass through ZeroProxy runtime helpers.
- Keep the invariant that target network/navigation cannot escape the ZeroProxy path.
- Fail closed in strict mode: if JavaScript that must be rewritten cannot be parsed or transformed, do not execute the original source.
- Keep `#k=<key>` out of target-visible state; rewriting must never replace immediate key removal from the real URL.

## Non-goals

- Perfect native origin impersonation. In a standard same-origin proxy document, the browser's native `Location` object cannot be made indistinguishable from the target origin.
- Anti-bot stealth, CAPTCHA bypass, or native function string spoofing.
- Executing unparsed original target JavaScript as a compatibility fallback in strict mode.
- Server-side session state or server-side target JavaScript storage.

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
       -> Rust + SWC parser compiled to WASM
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
| Rewriter WASM | new Rust crate, built to a web/service-worker-compatible WASM artifact | Parse JavaScript with SWC, perform AST transforms, return rewritten source and diagnostics. |
| Service Worker Rewriting Service | `web/sw.js` plus a new internal module/glue asset | Load the rewriter WASM, decide when to rewrite, cache transformed results, enforce fail-closed policy. |
| Runtime membrane | `web/runtime-prelude.js` | Provide `__zp_get`, `__zp_set`, `__zp_call`, `__zp_construct`, virtual `Location`, virtual window wrappers, and navigation helpers used by rewritten code. |
| Foreground synchronous rewriter | `web/runtime-prelude.js` plus the same SWC WASM artifact or a smaller dynamic-code rewriter artifact | Preinitialize a closure-private rewriter in the target page for synchronous `eval`, `Function`, and string timer rewriting. |
| HTML integration | `internal/htmltx` and `cmd/wasm-kernel` | Rewrite inline scripts and inline event handlers before the browser compiles them. |
| External script pipeline | `web/sw.js` | Rewrite `script`, `module`, worker, and imported script responses before returning them to the browser. |

## Service Worker Rewriting Service

The Service Worker owns the rewrite decision because it already classifies every controlled request and has the target context.

### Initialization

- Add a rewrite readiness stage separate from Go kernel transport readiness:

```text
REWRITE_UNINITIALIZED -> REWRITE_LOADING -> REWRITE_READY -> REWRITE_FAILED
```

- Load the SWC rewriter WASM as an internal asset, for example:

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

- `eval`, indirect eval, and `new Function` are blocked unless a synchronous page-local rewrite path is present.
- `setTimeout(string)` and `setInterval(string)` may asynchronously rewrite before scheduling, but strict mode may also block them for simpler semantics.
- `({}).constructor.constructor(...)` and similar access to `Function` must be rewritten to the same policy.
- Phase 2 includes a foreground synchronous rewriter for dynamic-code compatibility. Strict mode still blocks dynamic code when that foreground path is unavailable, uninitialized, version-mismatched, or unable to rewrite safely.

## Foreground synchronous rewriter

Dynamic code APIs are synchronous. A Service Worker rewriter cannot serve them without changing browser-visible semantics, so Phase 2 instantiates a foreground rewriter in the controlled page before target scripts run.

```text
runtime-prelude.js
  -> instantiate /__zp/js-rewriter.wasm or /__zp/js-dynamic-rewriter.wasm
  -> keep the instance in closure-private state
  -> patch eval / Function / timers / dynamic HTML compilation APIs
  -> rewritten dynamic code calls the same runtime membrane helpers
```

Requirements:

- The foreground rewriter must initialize before any target-controlled script can execute. If it is required by the selected mode and initialization fails, target script execution fails closed with `REALM_INJECTION_FAILURE`.
- The foreground rewriter API must not be exposed as `window.__zp_rewrite` or any other target-visible global. Target code may call patched dynamic-code APIs, but must not be able to invoke, configure, or downgrade the rewriter directly.
- The foreground and Service Worker rewriters must use the same transformer version and helper ABI. The runtime must compare an embedded transformer version/hash and fail closed on mismatch.
- The page-local instance should be limited to dynamic-code rewriting. The Service Worker remains the canonical pipeline for external scripts, inline scripts, worker scripts, caching, diagnostics, and strict-mode policy decisions.
- If the full SWC WASM artifact is too large for foreground startup, Phase 2 may add a smaller dynamic-code-only Rust/SWC build. The smaller build must share the same AST rewrite rules for dangerous access paths.
- Foreground rewriting must never expose share keys, transport secrets, HttpOnly cookies, or Service Worker state to target code.
- CSP must explicitly allow only the minimum needed for foreground WASM initialization. Any continued use of `'unsafe-eval'` or `wasm-unsafe-eval` must be documented as a compatibility requirement and revisited after dynamic rewriting is complete.

Dynamic execution hooks required in the foreground runtime:

- `eval(source)` and indirect eval-like calls that can be observed after static rewrite.
- `Function(...args, body)`, plus `AsyncFunction`, `GeneratorFunction`, and `AsyncGeneratorFunction` constructors.
- Constructor escape paths such as `({}).constructor.constructor(...)` and `fn.constructor(...)`.
- String timers: `setTimeout("code", ...)` and `setInterval("code", ...)`.
- Inline event handler mutation APIs: `Element.prototype.setAttribute`, `setAttributeNS`, `Attr.value`, `NamedNodeMap.setNamedItem`, and handler IDL setters where browsers compile string handlers.
- Dynamic HTML compilation APIs that can introduce event handlers or scripts: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `document.writeln`, `Range.prototype.createContextualFragment`, `DOMParser.prototype.parseFromString`, `iframe.srcdoc`, and `template.innerHTML`.
- Blob/data script creation paths: `URL.createObjectURL(new Blob([...], { type: 'text/javascript' }))`, worker blob URLs, and data URL workers.
- Worker and worklet dynamic loaders: `Worker`, `SharedWorker`, `importScripts`, and `addModule`.

String replacement is explicitly forbidden for this layer. A patch like `code.replace(/location/g, ...)` corrupts string literals, object keys, comments, locally-bound identifiers, and unrelated words. Every executable string must be parsed in the correct grammar mode: full script, module, function body, event handler body, or timer/eval program. Rewrite failure in strict mode means block, not execute original source.

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

The SWC transform must use scope-aware analysis. It must not rewrite locally-bound variables named `location`, `window`, `document`, etc.

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

1. Service Worker loads the SWC rewriter WASM and exposes a synchronous `__zp_rewrite_js(source, options)` function in the Service Worker global.
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
2. Read the script body as text. SWC requires a full source string; script bodies are allowed to be buffered even though non-script response bodies should keep streaming.
3. Rewrite with SWC.
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
- No target script may observe `#k=<key>` after share activation.
- No target script may receive the Go kernel transport secrets, stream isolation key material, or HttpOnly cookie state.
- Rewritten navigation must remain on proxy-origin `/p` routes unless a later phase intentionally reintroduces `/v` active routes.
- CSP remains defense-in-depth; Service Worker classification and the transport kernel remain the egress boundary.
- Original source is never executed in strict mode when rewriting is required.

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

### Browser E2E tests

- `gosuda.org` home cards navigate through `/p` routes.
- `gosuda.org` language dropdown button navigation stays on proxy-origin `/p` routes.
- A test page reading `location.href`, `window.location.href`, `document.URL`, and `document.defaultView.location.href` observes the virtual target URL from rewritten code.
- A hostile test page using `window['loca' + 'tion']`, `Reflect.get(window, 'location')`, iframe clean realms, and `Function('return location.href')` is rewritten or blocked according to strict mode.
- No tested path changes the top-level URL to the target origin.

### Performance tests

- Measure parser/transform latency by script size buckets: 10 KB, 100 KB, 1 MB, 5 MB.
- Measure first-page-load overhead with and without memory cache.
- Ensure non-script response streaming is not regressed.

## Implementation sequence

1. Add rewriter mode configuration and diagnostics plumbing.
2. Add Rust SWC rewriter crate and WASM build target.
3. Load rewriter WASM from the Service Worker and expose `rewriteScript()`.
4. Add runtime membrane helpers used by rewritten code.
5. Add the foreground synchronous rewriter bootstrap and closure-private dynamic-code rewrite API.
6. Patch `eval`, indirect eval, `Function`, string timers, constructor-constructor escapes, and dynamic HTML compilation APIs to use the foreground rewriter or block.
7. Rewrite external classic scripts in the Service Worker.
8. Add module script support.
9. Add Go HTML transform callback for inline scripts and inline event handlers.
10. Add worker/importScripts/blob/data script rewriting.
11. Add browser E2E tests and hostile escape fixtures.
12. Tighten CSP once compatibility data is available.

## Acceptance criteria

Phase 2 is accepted when:

- The Service Worker initializes the SWC-based Rust/WASM rewriting service before target script execution in strict mode.
- External scripts, inline scripts, event handlers, and worker scripts are rewritten or blocked.
- Dynamic code execution is rewritten synchronously by an approved page-local path or blocked.
- Runtime-created event handlers and dynamic HTML paths (`setAttribute`, `innerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`, `Range`) are rewritten before browser compilation or neutralized.
- Foreground dynamic-code rewriting is initialized before target scripts, is not target-visible as a public API, and version-matches the Service Worker rewriter.
- Rewritten code observes virtual location values through the runtime membrane in the required browser E2E tests.
- `gosuda.org` click navigation and language dropdown navigation remain on proxy-origin `/p` routes.
- Hostile tests for `window['loca' + 'tion']`, `Reflect.get`, iframe clean realms, and constructor-constructor dynamic code do not expose a native direct-egress path.
- All strict-mode rewrite failures produce safe ZeroProxy errors instead of executing original target code.
