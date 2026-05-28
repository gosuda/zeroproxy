# ZeroProxy Phase 3 Plan: Strict Script Compatibility and Module Correctness

Status: proposed. This plan is based on the current Phase 2 implementation plus the compatibility investigation performed after Phase 2. Existing unit, Go, and Puppeteer E2E tests pass, but they do not cover several script paths that still break compatibility or fail the strict rewrite boundary.

Phase 3 is a clean cutover plan for script correctness. The goal is not to widen the network boundary. The goal is to make script execution predictable: every executable target script is either rewritten under the ZeroProxy membrane, resolved through the same-origin script API, or blocked with an explicit ZeroProxy error.

## Goals

- Close script-created inline execution gaps without executing unrewritten target code.
- Make module resolution compatible with relative imports, absolute imports, bare specifiers, import maps, dynamic `import()`, and `import.meta.url`.
- Fix rewriter lexical-scope correctness so local bindings are never mistaken for globals and globals are never missed.
- Make strict-mode rewrite failures fail closed consistently across external scripts, inline scripts, event handlers, workers, and dynamic compilation paths.
- Keep the transport invariant unchanged: target network, navigation, worker, and WebSocket traffic must stay inside `Service Worker -> Go WASM -> WebSocket/yamux -> SOCKS5 -> uTLS/HTTP`.
- Add browser E2E coverage for the exact compatibility breakages listed below.

## Non-goals

- Full target Service Worker emulation. Target Service Worker registration remains blocked.
- Anti-bot stealth or CAPTCHA bypass.
- Perfect native origin impersonation. Native browser `Location` and the real address bar remain proxy-origin-backed.
- Raw blob/data script execution without a rewritten or contained execution path.
- Reintroducing native `fetch(event.request)` or native cross-origin script fallbacks.

## Current compatibility failures and strict-boundary gaps

### 1. Script-created inline scripts execute outside the rewrite pipeline

Observed behavior:

```js
const s = document.createElement('script');
s.textContent = "window.__ran = { href: location.href }";
document.head.appendChild(s);
```

The script runs. Inside that script, `location.href` observes the real proxy `/p/...#k=...` URL instead of the virtual target URL. Dynamic HTML sinks such as `innerHTML = '<script>...</script>'` are already made inert, but direct script element text is not rewritten or blocked before insertion.

Affected code:

- `web/runtime-prelude.js`: script URL laundering handles `script.src`, but insertion hooks do not block or rewrite script text.
- `web/runtime-prelude.js`: dynamic HTML `transformHTML()` blocks string-created `<script>` tags only.

Required Phase 3 behavior:

- Before a script element can execute, classify it as one of:
  - external executable script with `src` -> launder through `/__zp/api/script`;
  - inline classic script -> rewrite synchronously or block;
  - inline module script -> rewrite synchronously or block;
  - non-executable script data type -> leave inert;
  - import map -> parse and register/rewrite as import-map metadata, not execute as code.
- Patch insertion paths that can activate detached script nodes: `appendChild`, `insertBefore`, `replaceChild`, `append`, `prepend`, `before`, `after`, `replaceWith`, and equivalent document-fragment insertion.
- Patch `HTMLScriptElement.text`, `textContent`, `innerText`, and child text node mutations where the browser would execute script content on insertion.
- Prefer blocking over executing source when synchronous rewrite is unavailable.

### 2. Bare module imports and import maps are currently broken

Observed behavior:

```js
import React from 'react';
```

The rewriter turns this into a target-relative URL such as:

```js
import React from "/__zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Freact";
```

That is not browser module semantics. A bare specifier must be resolved by the page import map or fail as a browser module-resolution error. Blindly resolving it against the module URL breaks sites that depend on import maps, package-style specifiers, or build-system import-map shims.

Affected code:

- `web/js-rewriter.js`: `moduleSpecifier()` resolves every specifier with `new URL(specifier, moduleTargetURL)`.
- `internal/htmltx/transform.go`: `type="importmap"` is not handled as a first-class module-resolution input.

Required Phase 3 behavior:

- Distinguish specifier classes:
  - relative-like: `./x.js`, `../x.js`, `/x.js`;
  - absolute URL: `https://...`, `http://...`;
  - special schemes: `data:`, `blob:`, `node:`, etc.;
  - bare: `react`, `@scope/pkg`, `pkg/subpath`.
- Rewrite only relative-like and HTTP(S) absolute specifiers directly.
- Preserve or resolve bare specifiers according to a parsed import map. Do not treat them as URL paths.
- Transform import maps before module execution:
  - parse JSON safely;
  - rewrite mapped HTTP(S)/relative addresses to `/__zp/api/script?kind=module&u=...`;
  - preserve invalid import-map behavior as close to the browser as practical;
  - block import-map entries with executable or unsupported schemes.
- Add tests for bare specifier with import map, bare specifier without import map, scoped import-map entries, and absolute/relative module imports.

### 3. `import.meta.url` remains proxy API URL-backed

Observed behavior:

```js
export const rel = new URL('./chunk.js', import.meta.url).href;
```

The rewriter leaves `import.meta.url` unchanged. Because rewritten modules execute from `/__zp/api/script?...`, code that resolves URLs against `import.meta.url` can resolve relative chunks against the proxy API URL instead of the original target module URL.

Required Phase 3 behavior:

- Rewriter must replace `import.meta.url` with the original target module URL string, or an equivalent immutable helper value.
- `new URL('./chunk.js', import.meta.url)` must produce the original target-relative URL, then any subsequent module/script load must be routed through ZeroProxy.
- Add E2E coverage for a module that creates a Worker and dynamic import from `new URL(..., import.meta.url)`.

### 4. Non-literal dynamic `import()` is not rewritten

Observed behavior:

```js
export async function load(name) {
  return import('./chunks/' + name + '.js');
}
```

Literal dynamic imports are rewritten, but expression-based imports are left untouched. That can later route through the Service Worker with the wrong module kind or resolve against proxy-owned URLs.

Required Phase 3 behavior:

- Rewrite expression dynamic imports to a helper path, for example:

```js
import(__zp_module_url(expr, originalModuleURL))
```

- The helper must:
  - resolve relative-like and HTTP(S) absolute specifiers against the original target module URL;
  - consult the transformed import-map registry for bare specifiers;
  - return a same-origin `/__zp/api/script?kind=module&u=...` URL;
  - fail closed for unsupported schemes.
- Service Worker classification must preserve module kind for module subresource fetches instead of falling back to classic script rewriting.

### 5. Rewriter lexical scoping mishandles `var` hoisting

Observed behavior:

```js
function f(x) {
  if (x) { var location = { href: 'local' }; }
  return location.href;
}
```

The current output rewrites the final `location` as global `location`, even though `var location` is function-scoped. This is a correctness bug, not only a compatibility bug.

Affected code:

- `web/js-rewriter.js`: scope collection treats block body declarations too uniformly and does not model `var` hoisting to the nearest function/program scope.

Required Phase 3 behavior:

- Implement a real scope model:
  - program scope;
  - function scope;
  - block scope;
  - catch scope;
  - class scope where relevant;
  - module import/export bindings;
  - `var` and function-declaration hoisting to function/program scope;
  - `let`/`const`/class bindings to block scope;
  - parameter and function-name scopes.
- Add rewriter unit tests for shadowing across blocks, functions, loops, catch clauses, destructuring, imports, class names, and nested functions.
- Fail closed only for unsupported syntax or ambiguous transformations, not for valid local-shadowing code.

### 6. Inline classic and event-handler fallback is not strict fail-closed

Current behavior:

- External script rewrite failure returns a throwing script.
- Inline module fallback returns a throwing script.
- Inline classic script and event-handler fallback can execute original source wrapped in `__zp_runClassic` / `__zp_runEvent` when the OXC rewriter is unavailable.

Affected code:

- `internal/htmltx/transform.go`: `rewriteInlineScript()` and `rewriteEventHandler()` compatibility fallback.
- `cmd/wasm-kernel/main.go`: `rewriteScript()` returns false when the JS rewriter is unavailable or fails.

Required Phase 3 behavior:

- Default strict path: inline classic scripts and event handlers must block when OXC rewrite fails.
- If a compatibility mode is retained, it must be explicit, test-named, and documented as lower assurance.
- The default E2E path must prove parse/rewrite failures do not execute original inline source.

### 7. Compatibility passthrough allowlist remains an acceptance-boundary exception

Current behavior:

- `/__zp/api/script` bypasses rewriting for selected third-party challenge/tag-manager hosts.
- This is not a parse-failure fallback, but it is still a strict-mode exception.

Affected code:

- `web/sw.js`: `shouldPassthroughScript()`.

Required Phase 3 behavior:

- Decide one strict default:
  - remove passthrough from strict mode; or
  - move passthrough behind an explicit compatibility policy flag with host/path allowlist tests.
- Strict/high-assurance acceptance must not depend on passthrough scripts executing unrewritten.

### 8. Worker script API compatibility remains partial

Current behavior:

- Worker `fetch` and `importScripts` are routed.
- Worker XHR, WebSocket, EventSource, WebRTC/WebTransport, device APIs, and blob/data worker scripts are blocked or prototype-level.

Required Phase 3 behavior:

- Keep blocked APIs explicit and test-covered.
- Add compatibility only where it can preserve the transport boundary:
  - worker XHR over `/__zp/api/fetch` if needed;
  - worker EventSource over fetch stream if needed;
  - worker WebSocket only through the existing `ZP_WS_OPEN`/`__zp_stream` path with per-tab capability.
- Do not silently expose native worker networking.

## Implementation sequence

### Gate 0: Add failing fixtures first

Add tests before changing behavior:

- Rewriter unit tests:
  - `var` hoisting shadowing of `location`, `window`, `document`, `Function`, `WebSocket`;
  - bare module imports with and without import-map metadata;
  - `import.meta.url` replacement;
  - literal and expression dynamic `import()`;
  - inline module rewrite failure path.
- Runtime unit/static tests:
  - script-created inline text is not executed unrewritten;
  - script insertion hooks cover all activation methods;
  - import-map scripts are not treated as executable classic/module scripts.
- Browser E2E tests:
  - script-created inline `textContent` cannot observe proxy `/p/...#k=...` location;
  - module fixture using import map and `import.meta.url` loads through `/__zp/api/script` and observes target URL;
  - expression dynamic import loads target chunk through the script API;
  - malformed inline classic/event-handler source blocks in strict mode.

### Gate 1: Runtime script element activation policy

Update `web/runtime-prelude.js` so script elements are normalized immediately before activation.

Required changes:

- Add `prepareScriptElement(el)` and call it from every insertion hook before native insertion.
- If `el.src` is executable, route through `setScriptSource()`.
- If inline executable code exists, synchronously rewrite through the page-local rewriter when available; otherwise set an inert blocked type or replace content with a throwing strict block.
- Preserve non-executable script data blocks, including JSON and import maps.
- Ensure document fragments are recursively inspected before insertion.
- Keep `document.currentScript` behavior as close as practical for rewritten inline scripts.

### Gate 2: Import map and module resolver design

Add a single module-resolution contract shared by the HTML transformer, runtime prelude, and Service Worker rewriter.

Required changes:

- Introduce an import-map parser/normalizer for target documents.
- Transform static `<script type="importmap">` blocks in `internal/htmltx`.
- Transform dynamic import-map insertions in `runtime-prelude.js` before the browser observes them.
- Add a runtime helper for expression dynamic imports.
- Extend `web/js-rewriter.js` with specifier classification instead of `new URL()` on every specifier.
- Pass the original target module URL into every module rewrite operation and expose it to rewritten code for `import.meta.url` replacement.

### Gate 3: Rewriter scope model rewrite

Refactor `web/js-rewriter.js` scope handling before expanding more syntax rewrites.

Required changes:

- Separate declaration collection from expression rewrite traversal.
- Model `var`/function hoisting to function/program scope.
- Model lexical block bindings for `let`, `const`, class, catch, and import bindings.
- Cover destructuring and default parameter initializers.
- Avoid rewriting identifiers in declarations, property keys, labels, and type-like positions.
- Keep replacement ordering deterministic and reject overlapping replacements that would produce invalid syntax.

### Gate 4: Strict fail-closed inline policy

Update the Go HTML transform and WASM kernel integration.

Required changes:

- Make strict inline classic/event-handler rewrite failure return a throwing script or inert handler, not `__zp_runClassic`/`__zp_runEvent` around original source.
- If a compatibility mode remains, thread an explicit option from configuration to `htmltx.Options` and name it in tests.
- Add safe ZeroProxy error diagnostics for blocked inline code without exposing source or secrets.

### Gate 5: Service Worker script-kind preservation

Update `web/sw.js` script APIs.

Required changes:

- Preserve module/classic/worker kind across `/__zp/api/script` and subresource classification.
- Ensure dynamic-import generated API URLs always carry `kind=module`.
- Remove or policy-gate `shouldPassthroughScript()` from strict mode.
- Keep `scriptResponseHeaders()` strict: `nosniff`, `no-store`, and ZeroProxy CSP.

### Gate 6: Worker compatibility boundary

Document and test worker behavior after module fixes.

Required changes:

- Keep worker blocked APIs explicit.
- Add worker module import and dynamic import coverage.
- Only add worker XHR/EventSource/WebSocket compatibility if implemented through existing ZeroProxy APIs.

## Verification plan

Run these after each gate that changes behavior:

```sh
npm run test:js
go test ./...
npm run test:e2e
```

Add targeted browser fixtures for:

- script-created inline text;
- dynamic document-fragment insertion containing scripts;
- import map + bare module import;
- `import.meta.url` relative chunk loading;
- expression dynamic import;
- inline parse failure strict block;
- worker module import path;
- passthrough-policy disabled strict mode.

Verification claims must distinguish:

- static policy coverage;
- unit rewriter coverage;
- Go HTML-transform coverage;
- browser E2E runtime coverage;
- strict-mode versus compatibility-mode behavior.

## Acceptance criteria

Phase 3 is accepted when all of the following are true:

- A script element created with inline text cannot execute original target code outside the rewriter/membrane path.
- All script activation paths either rewrite, launder, or block before browser execution.
- Bare module specifiers are not blindly converted to target-relative URLs.
- Import maps are transformed or honored well enough for bare specifier E2E fixtures.
- `import.meta.url` in rewritten modules exposes the original target module URL semantics required by relative chunk loading.
- Literal and expression dynamic imports load module chunks through `/__zp/api/script?kind=module&u=...` or fail closed for unsupported schemes.
- Rewriter scope tests prove `var` hoisting and lexical shadowing do not cause global helper rewrites for local bindings.
- Inline classic and event-handler rewrite failures fail closed in strict mode.
- Strict mode does not depend on unrewritten third-party passthrough scripts.
- Worker script imports remain routed through ZeroProxy, and blocked worker APIs are explicit in tests.
- `npm run test:js`, `go test ./...`, and `npm run test:e2e` pass with the new fixtures.

## Files expected to change

- `web/js-rewriter.js`
- `web/runtime-prelude.js`
- `web/worker-prelude.js`
- `web/sw.js`
- `internal/htmltx/transform.go`
- `internal/htmltx/transform_test.go`
- `cmd/wasm-kernel/main.go`
- `test/js/rewriter.test.js`
- `test/js/static-policy.test.js`
- `test/js/compat-pipeline.test.js`
- `test/e2e/proxy.test.js`
- `ARCHITECTURE.md`

## Open design decisions

1. Strict default for compatibility passthrough:
   - recommended: remove passthrough from strict mode and add an explicit lower-assurance compatibility flag if needed.
2. Import-map implementation location:
   - recommended: parse and rewrite import maps in both static HTML transform and runtime dynamic insertion path, with one shared JS resolver contract for module rewriting.
3. Inline script rewrite location:
   - recommended: use the already-loaded page-local OXC rewriter for runtime-created inline scripts; block when unavailable.
4. Worker API parity:
   - recommended: keep worker XHR/WebSocket/EventSource blocked until each can be routed through existing ZeroProxy APIs with E2E coverage.
