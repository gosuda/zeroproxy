# ZeroProxy Phase 3 Plan: Strict Script Compatibility, Navigation Integrity, and Stealth Membrane

Status: proposed. This plan is based on the current Phase 2 implementation, the compatibility investigation performed after Phase 2, and the subsequent anti-bot fingerprinting review. Existing unit, Go, and Puppeteer E2E tests pass, but they do not cover several script paths, document-navigation rewrites, dynamic HTML parser paths, stealth-membrane observability surfaces, or `WebSocketStream` compatibility.

Phase 3 is a clean cutover plan for strict script correctness plus local script-observable membrane consistency. The goal is not to widen the network boundary. The goal is to make script execution and navigation predictable: every executable target script is either rewritten under the ZeroProxy membrane, resolved through the same-origin script API, or blocked with an explicit ZeroProxy error; every document navigation target is routed through the same ZeroProxy navigation path; every ZeroProxy control artifact that must exist in the real DOM is hidden from target-page observability APIs covered by this plan.

The canonical internal URL prefix remains `/__zp/...`. Any implementation sketch or external proposal spelling `/_zp/...` must be normalized to `/__zp/...`; introducing a second internal prefix is prohibited.

## Goals

- Close script-created inline execution gaps without executing unrewritten target code.
- Make module resolution compatible with relative imports, absolute imports, bare specifiers, import maps, dynamic `import()`, and `import.meta.url`.
- Fix rewriter lexical-scope correctness so local bindings are never mistaken for globals and globals are never missed.
- Make strict-mode rewrite failures fail closed consistently across external scripts, inline scripts, event handlers, workers, and dynamic compilation paths.
- Repair Go HTML-transform navigation rewriting for document-navigation attributes, especially `<a href>`, `<area href>`, `<form action>`, `<input formaction>`, and `<button formaction>`, not only `<iframe src>` and `<frame src>`.
- Replace the runtime dynamic-HTML regular-expression rewrite path with an inert DOM tree traversal path for `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser.parseFromString('text/html')`, and `Range.createContextualFragment`.
- Add a stealth membrane for ZeroProxy framework artifacts: in-page scripts must not observe `data-zp-*` control attributes or injected ZeroProxy boot/script assets through the DOM APIs enumerated below.
- Add a `WebSocketStream` polyfill that maps the Streams API shape onto the existing proxied `WebSocket` transport path, without exposing native networking.
- Keep the transport invariant unchanged: target network, navigation, worker, WebSocket, and `WebSocketStream` traffic must stay inside `Service Worker -> Go WASM -> WebSocket/yamux -> SOCKS5 -> uTLS/HTTP`.
- Add browser E2E coverage for the exact compatibility and fingerprinting breakages listed below.

## Non-goals

- Full target Service Worker emulation. Target Service Worker registration remains blocked.
- CAPTCHA solving or changing a remote anti-abuse service's server-side decision. Phase 3 only removes local ZeroProxy artifact leakage and routing inconsistencies that create mismatched telemetry.
- Perfect native origin impersonation beyond the enumerated membrane surfaces. Native browser `Location` and the real address bar remain proxy-origin-backed, with virtualized script APIs where ZeroProxy already owns the membrane.
- Raw blob/data script execution without a rewritten or contained execution path.
- Reintroducing native `fetch(event.request)` or native cross-origin script fallbacks.
- Exposing native worker, WebSocket, `WebSocketStream`, WebRTC, or WebTransport networking outside the existing ZeroProxy transport boundary.

## Current compatibility failures and strict-boundary gaps

### 1. Static document-navigation attributes are not rewritten

Observed behavior:

```html
<a href="/account">Account</a>
<form action="/login"></form>
<button formaction="/checkout"></button>
```

The Go HTML transformer identifies these attributes as rewrite candidates, but the rewritten value is only assigned when the tag is `iframe` or `frame`. As a result, normal document-navigation attributes can pass through with their original target URL even when `wrapAttrURL()` succeeds.

Current problematic branch in `internal/htmltx/transform.go`:

```go
if shouldRewriteAttr(tag, key) {
    trimmed := strings.TrimSpace(a.Val)
    if trimmed == "" || strings.HasPrefix(trimmed, "#") {
        attrs = append(attrs, a)
        continue
    }
    wrapped, target, ok := wrapAttrURL(a.Val, opt, isDocumentNavigationAttr(tag, key))
    if ok {
        // Bug: successful rewrites are committed only for frames.
        if tag == "iframe" || tag == "frame" {
            a.Val = wrapped
            dataTarget = target
        }
    } else if isDocumentNavigationAttr(tag, key) {
        a.Val = "#"
        attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
    }
}
```

Required Phase 3 behavior:

- `a[href]`, `area[href]`, `form[action]`, `input[formaction]`, `button[formaction]`, `iframe[src]`, and `frame[src]` must all commit the wrapped URL when `wrapAttrURL()` succeeds.
- `data-zp-target-url` must be set to the original absolute target URL for every successfully wrapped document-navigation attribute so runtime virtual URL APIs can recover target semantics.
- Empty values and same-document fragments continue to pass through unchanged.
- Executable or unsupported schemes (`javascript:`, `data:`, `vbscript:`, non-HTTP(S), parse failures) must fail closed for document navigation: visible attribute becomes `#` and original trimmed input is preserved in `data-zp-blocked-url` for internal policy/debug handling.
- `<iframe>` and `<frame>` may still require runtime activation handling, but that must not be expressed as a guard that prevents `<a>`, `<form>`, or submitter elements from receiving rewritten attributes.

Required Go fix shape:

```go
if shouldRewriteAttr(tag, key) {
    trimmed := strings.TrimSpace(a.Val)
    if trimmed == "" || strings.HasPrefix(trimmed, "#") {
        attrs = append(attrs, a)
        continue
    }
    wrapped, target, ok := wrapAttrURL(a.Val, opt, isDocumentNavigationAttr(tag, key))
    if ok {
        a.Val = wrapped
        dataTarget = target
    } else if isDocumentNavigationAttr(tag, key) {
        a.Val = "#"
        attrs = append(attrs, xhtml.Attribute{Key: "data-zp-blocked-url", Val: trimmed})
    }
}
```

Acceptance evidence must include Go transformer tests proving at least:

- `<a href="/x">` becomes a ZeroProxy share/navigation URL and carries `data-zp-target-url` for the absolute target URL.
- `<form action="/submit">`, `<input formaction="/go">`, and `<button formaction="/go">` are rewritten.
- `href="#section"` remains unchanged.
- `href="javascript:alert(1)"` is blocked as `#` with `data-zp-blocked-url`.

### 2. Script-created inline scripts execute outside the rewrite pipeline

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

### 3. Runtime dynamic HTML transformation is regex-based and parser-incorrect

Observed behavior:

`web/runtime-prelude.js` currently transforms HTML strings with chained regular-expression replacements:

```js
function transformHTML(s) {
  return String(s)
    .replace(/<base\b[^>]*\shref=(["'])([\s\S]*?)\1[^>]*>/ig, (_, q, href) => baseSyncScript(href))
    .replace(blockedLinkTagRE, rewriteBlockedLinkTag)
    .replace(/(<iframe\b[^>]*\ssrcdoc=["'])([\s\S]*?)(["'])/ig, (_, p, h, q) => p + injectSrcdoc(h).replace(/"/g,'&quot;') + q)
    .replace(/<script\b/ig, '<script type="application/x-zeroproxy-blocked" data-zp-blocked-script')
    .replace(/\sintegrity\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)/ig, (_, value) => ' ' + integrityBackupAttr + '=' + value)
    .replace(/\s(on[a-z0-9_:-]+)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)/ig, (_, name, value) => ' data-zp-blocked-' + name.toLowerCase() + '=' + value);
}
```

This is parser-incorrect for malformed-but-browser-accepted markup, mixed quoting, nested `srcdoc`, raw-text elements, entity normalization, and anti-bot fixtures that intentionally stress HTML tokenization. It also creates an unnecessary regex fingerprint in the dynamic HTML path.

Required Phase 3 behavior:

- Replace markup regex rewriting in `transformHTML()` with an inert DOM parser path:
  - create an isolated HTML document via `document.implementation.createHTMLDocument('')`;
  - create a container element owned by that inert document;
  - assign `container.innerHTML = htmlString` to let the browser parser tokenize;
  - traverse elements using `TreeWalker` or equivalent native tree traversal;
  - mutate parsed nodes structurally;
  - return `container.innerHTML`.
- The parser document must not execute scripts or trigger target-network loads during transformation.
- Structural transform must cover the same policies as the old regex path:
  - `<base href>` becomes a safe sync script that calls `window.__ZP_SET_BASE(...)`;
  - blocked `<link rel=preload|preconnect|dns-prefetch|modulepreload|prefetch|prerender>` loses active `rel`/`href` and stores `data-zp-blocked-rel` / `data-zp-blocked-url` internally;
  - `<iframe srcdoc>` and `<frame srcdoc>` receive recursive ZeroProxy boot markup plus recursively transformed `srcdoc`;
  - executable `<script>` elements are made inert before they can execute;
  - `integrity` on script/link is moved to `data-zp-integrity`;
  - inline event-handler attributes are backed up under `data-zp-blocked-on...` and rewritten through the event-handler membrane.
- This requirement applies to dynamic HTML compilation paths only. Non-markup regular expressions used for URL/cookie/string normalization are not part of this cutover unless a test proves parser-relevant breakage.

Reference implementation shape:

```js
function transformHTML(htmlString) {
  if (!htmlString || typeof htmlString !== 'string') return htmlString;

  const parserDoc = document.implementation.createHTMLDocument('');
  const container = parserDoc.createElement('div');
  container.innerHTML = htmlString;

  const walker = parserDoc.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    const tag = node.localName;

    if (tag === 'base' && Native.getAttribute.call(node, 'href')) {
      const href = Native.getAttribute.call(node, 'href');
      updateVirtualBase(href);
      const s = parserDoc.createElement('script');
      s.textContent = `window.__ZP_SET_BASE&&window.__ZP_SET_BASE(${JSON.stringify(href)});`;
      node.replaceWith(s);
      continue;
    }

    if (tag === 'link') {
      const rel = Native.getAttribute.call(node, 'rel') || '';
      if (isBlockedLinkRelValue(rel)) {
        Native.setAttribute.call(node, 'data-zp-blocked-rel', rel);
        const href = Native.getAttribute.call(node, 'href') || '';
        if (href) Native.setAttribute.call(node, 'data-zp-blocked-url', href);
        Native.removeAttribute.call(node, 'rel');
        Native.removeAttribute.call(node, 'href');
      }
    }

    if ((tag === 'iframe' || tag === 'frame') && Native.hasAttribute.call(node, 'srcdoc')) {
      const srcdoc = Native.getAttribute.call(node, 'srcdoc') || '';
      Native.setAttribute.call(node, 'srcdoc', runtimePreludeBootMarkup() + transformHTML(srcdoc));
    }

    if (tag === 'script') {
      Native.setAttribute.call(node, 'type', 'application/x-zeroproxy-blocked');
      Native.setAttribute.call(node, 'data-zp-blocked-script', '1');
    }

    if (Native.getAttributeNames) {
      for (const attrName of Native.getAttributeNames.call(node)) {
        const lowerAttr = attrName.toLowerCase();
        if (lowerAttr === 'integrity' && isIntegrityBearing(node)) {
          const val = Native.getAttribute.call(node, attrName);
          Native.setAttribute.call(node, integrityBackupAttr, val);
          Native.removeAttribute.call(node, attrName);
        }
        if (lowerAttr.startsWith('on') && lowerAttr.length > 2) {
          const val = Native.getAttribute.call(node, attrName);
          Native.setAttribute.call(node, `data-zp-blocked-${lowerAttr}`, val);
          Native.setAttribute.call(node, attrName, rewriteEventAttribute(val));
        }
      }
    }
  }

  return container.innerHTML;
}

function runtimePreludeBootMarkup() {
  return `<script nonce=zp src=/__zp/zp-core.js></script>` +
    `<script nonce=zp id=__zp-boot type=application/json>${bootJSON()}</script>` +
    `<script nonce=zp src=/__zp/runtime-prelude.js></script>`;
}
```

### 4. Bare module imports and import maps are currently broken

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

### 5. `import.meta.url` remains proxy API URL-backed

Observed behavior:

```js
export const rel = new URL('./chunk.js', import.meta.url).href;
```

The rewriter leaves `import.meta.url` unchanged. Because rewritten modules execute from `/__zp/api/script?...`, code that resolves URLs against `import.meta.url` can resolve relative chunks against the proxy API URL instead of the original target module URL.

Required Phase 3 behavior:

- Rewriter must replace `import.meta.url` with the original target module URL string, or an equivalent immutable helper value.
- `new URL('./chunk.js', import.meta.url)` must produce the original target-relative URL, then any subsequent module/script load must be routed through ZeroProxy.
- Add E2E coverage for a module that creates a Worker and dynamic import from `new URL(..., import.meta.url)`.

### 6. Non-literal dynamic `import()` is not rewritten

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

### 7. Rewriter lexical scoping mishandles `var` hoisting

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

### 8. Inline classic and event-handler fallback is not strict fail-closed

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

### 9. Compatibility passthrough allowlist remains an acceptance-boundary exception

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

### 10. Worker script API compatibility remains partial

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

### 11. ZeroProxy control artifacts are script-observable through DOM fingerprinting APIs

Observed behavior:

ZeroProxy must attach internal attributes and injected boot assets to maintain routing and rewriting state, for example `data-zp-target-url`, `data-zp-blocked-url`, `data-zp-integrity`, `data-zp-blocked-script`, `#__zp-boot`, and `/__zp/zp-core.js` / `/__zp/runtime-prelude.js`. Anti-bot and integrity scripts can enumerate these artifacts through:

- `element.innerHTML` and `element.outerHTML`;
- `getAttribute`, `hasAttribute`, `getAttributeNames`, and `attributes` / `NamedNodeMap`;
- `document.scripts`, `getElementsByTagName('*')`, `getElementsByTagName('script')`, and related count APIs;
- `NodeIterator`, `TreeWalker`, and manual traversal;
- selector APIs such as `querySelectorAll('[data-zp-target-url]')`, `matches()`, and `closest()`.

Required Phase 3 behavior:

- Add a stealth membrane that hides ZeroProxy framework artifacts from target-page script-level inspection while preserving internal access through captured native references and private state such as `WeakMap` metadata.
- The membrane must cover at least:
  - `Element.prototype.innerHTML` and `outerHTML` getters;
  - `Element.prototype.getAttribute`, `hasAttribute`, `getAttributeNames`, `attributes`;
  - `NamedNodeMap.length`, numeric indexing, `item()`, `getNamedItem()`, iteration, and property access;
  - `Document.prototype.getElementsByTagName` and `Element.prototype.getElementsByTagName` for `*`, `script`, `meta`, `link`, and any tag that can expose injected assets;
  - `Document.prototype.scripts` and any available script collection getters;
  - `Document.prototype.createNodeIterator` and `createTreeWalker`;
  - selector APIs that directly query `data-zp-*` attributes or injected ZeroProxy script IDs/sources.
- The membrane must not hide target-authored attributes that merely contain the substring `zp`; it hides the exact ZeroProxy-reserved namespace `data-zp-*` and exact internal boot assets.
- The membrane must preserve web-compatible collection behavior: stable order, numeric indexing, `length`, `item()`, iteration, and function `this` binding.
- Masked methods must be integrated with the existing native-function stringification layer so `Function.prototype.toString` does not expose wrapper bodies.
- Tests must assert both invisibility to page scripts and continued internal functionality.

Reference implementation shape for the core membrane:

```js
(() => {
  const mask = (fn, name) => { if (typeof fn === 'function') maskNativeFunction(fn, name); };
  const isZPAttr = name => typeof name === 'string' && name.toLowerCase().startsWith('data-zp-');
  const isZPAsset = node => node && (
    node.id === '__zp-boot' ||
    (node.localName === 'script' && Native.getAttribute.call(node, 'src')?.startsWith('/__zp/'))
  );

  const origInnerHTMLGet = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').get;
  const origOuterHTMLGet = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML').get;
  const origGetAttribute = Element.prototype.getAttribute;
  const origHasAttribute = Element.prototype.hasAttribute;
  const origGetAttributeNames = Element.prototype.getAttributeNames;
  const origAttributesGet = Object.getOwnPropertyDescriptor(Element.prototype, 'attributes').get;

  Object.defineProperty(Element.prototype, 'innerHTML', {
    get() { return sanitizeSerializedHTML(origInnerHTMLGet.call(this)); },
    configurable: true,
    enumerable: true
  });

  Object.defineProperty(Element.prototype, 'outerHTML', {
    get() { return sanitizeSerializedHTML(origOuterHTMLGet.call(this)); },
    configurable: true,
    enumerable: true
  });

  Element.prototype.getAttribute = function(name) {
    if (isZPAttr(name)) return null;
    return origGetAttribute.apply(this, arguments);
  };
  mask(Element.prototype.getAttribute, 'getAttribute');

  Element.prototype.hasAttribute = function(name) {
    if (isZPAttr(name)) return false;
    return origHasAttribute.apply(this, arguments);
  };
  mask(Element.prototype.hasAttribute, 'hasAttribute');

  Element.prototype.getAttributeNames = function() {
    return origGetAttributeNames.apply(this, arguments).filter(n => !isZPAttr(n));
  };
  mask(Element.prototype.getAttributeNames, 'getAttributeNames');

  Object.defineProperty(Element.prototype, 'attributes', {
    get() { return filteredNamedNodeMap(origAttributesGet.call(this), attr => !isZPAttr(attr.name)); },
    configurable: true,
    enumerable: true
  });

  const filterNodeList = list => filteredLiveCollection(list, node => !isZPAsset(node));

  const origDocumentGetElementsByTagName = Document.prototype.getElementsByTagName;
  const origElementGetElementsByTagName = Element.prototype.getElementsByTagName;
  Document.prototype.getElementsByTagName = function(tag) {
    const raw = origDocumentGetElementsByTagName.apply(this, arguments);
    return shouldFilterTag(tag) ? filterNodeList(raw) : raw;
  };
  Element.prototype.getElementsByTagName = function(tag) {
    const raw = origElementGetElementsByTagName.apply(this, arguments);
    return shouldFilterTag(tag) ? filterNodeList(raw) : raw;
  };
  mask(Document.prototype.getElementsByTagName, 'getElementsByTagName');
  mask(Element.prototype.getElementsByTagName, 'getElementsByTagName');

  const origScriptsGet = Object.getOwnPropertyDescriptor(Document.prototype, 'scripts').get;
  Object.defineProperty(Document.prototype, 'scripts', {
    get() { return filterNodeList(origScriptsGet.call(this)); },
    configurable: true,
    enumerable: true
  });

  const origCreateNodeIterator = Document.prototype.createNodeIterator;
  Document.prototype.createNodeIterator = function(root, whatToShow, filter) {
    const nativeIterator = origCreateNodeIterator.apply(this, arguments);
    return filteredIterator(nativeIterator, node => !isZPAsset(node));
  };
  mask(Document.prototype.createNodeIterator, 'createNodeIterator');
})();
```

`sanitizeSerializedHTML()`, `filteredNamedNodeMap()`, `filteredLiveCollection()`, `filteredIterator()`, and selector filtering must be implemented without recursively calling patched public APIs. They must use captured native descriptors and avoid avoidable string allocation except at API boundaries that are defined to return strings.

### 12. `WebSocketStream` is blocked instead of mapped onto the proxied WebSocket path

Current behavior:

- `web/runtime-prelude.js` blocks `WebSocketStream` with other unsupported networking APIs.
- Some modern browser/anti-bot code checks for `WebSocketStream` or uses the Streams API shape directly.

Required Phase 3 behavior:

- Provide a `WebSocketStream` polyfill when native `WebSocketStream` is absent or blocked by ZeroProxy policy.
- The polyfill must use the existing ZeroProxy `WebSocket` constructor/membrane so traffic still routes through `ZP_WS_OPEN` / `__zp_stream` and never through native networking.
- Constructor semantics:
  - `new WebSocketStream(url, options = {})` resolves `url` against the virtual location/base URL;
  - `options.protocols` is passed to `WebSocket` without inventing unsupported options;
  - `opened` is a promise resolving to `{ readable, writable, protocol, extensions }` after WebSocket open;
  - `closed` is a promise resolving to `{ closeCode, reason }` after close;
  - `readable` enqueues WebSocket messages and closes on socket close;
  - `writable.write(chunk)` sends chunks through `ws.send(chunk)`, `close()` closes the socket, and `abort()` closes the socket;
  - errors reject `opened` when open has not completed and error/close streams after open as web-compatibly as practical.
- The constructor and methods must be masked through the existing native-stringification layer.

Reference implementation shape:

```js
if (!root.WebSocketStream) {
  class WebSocketStream {
    constructor(url, options = {}) {
      const virtualBase = root.__zp_virtualLocation?.href || location.href;
      const targetUrl = new URL(url, virtualBase).href;
      let socketClosedResolve;
      this.closed = new Promise(resolve => { socketClosedResolve = resolve; });
      this.opened = new Promise((resolve, reject) => {
        try {
          const ws = new root.WebSocket(targetUrl, options.protocols);
          ws.binaryType = 'arraybuffer';
          let controllerReadable;
          const readable = new ReadableStream({
            start(controller) { controllerReadable = controller; },
            cancel() { ws.close(); }
          });
          const writable = new WritableStream({
            write(chunk) { ws.send(chunk); },
            close() { ws.close(); },
            abort() { ws.close(); }
          });
          ws.onopen = () => resolve({ readable, writable, protocol: ws.protocol, extensions: ws.extensions || '' });
          ws.onmessage = event => { if (controllerReadable) controllerReadable.enqueue(event.data); };
          ws.onerror = err => reject(err);
          ws.onclose = event => {
            try { controllerReadable && controllerReadable.close(); } catch {}
            socketClosedResolve({ closeCode: event.code, reason: event.reason });
          };
        } catch (err) {
          reject(err);
        }
      });
    }
  }
  maskNativeFunction(WebSocketStream, 'WebSocketStream');
  root.WebSocketStream = WebSocketStream;
}
```

## Phase 3 integration guidelines

- Treat the `<a>` / document-navigation rewrite bug as a kernel correctness fix, not a compatibility enhancement. It must land before any E2E fixture relies on target-page navigation.
- Treat dynamic HTML regex removal as a clean cutover for markup transformation. Do not keep a second regex fallback path for malformed HTML; browser parser behavior is the contract.
- Treat the stealth membrane as a consistency layer over ZeroProxy-owned artifacts. Internal code must use captured native APIs or private metadata; page code must see target-authored DOM, not ZeroProxy implementation details.
- Treat `WebSocketStream` as an API facade over the existing proxied `WebSocket` path. Do not add a parallel transport.
- Every new membrane hook must include a test proving both directions: page-observable hiding works, and ZeroProxy internal behavior still works.
- Implementation must avoid redundant string serialization and repeated full-collection materialization where a live-filtered proxy or indexed lazy scan is sufficient.

## Implementation sequence

### Gate 0: Add failing fixtures first

Add tests before changing behavior:

- Go HTML-transform tests:
  - `<a href>`, `<area href>`, `<form action>`, `<input formaction>`, and `<button formaction>` rewrite to ZeroProxy navigation/share URLs and retain `data-zp-target-url`;
  - fragment-only navigation remains unchanged;
  - executable schemes fail closed with `data-zp-blocked-url`.
- Rewriter unit tests:
  - `var` hoisting shadowing of `location`, `window`, `document`, `Function`, `WebSocket`;
  - bare module imports with and without import-map metadata;
  - `import.meta.url` replacement;
  - literal and expression dynamic `import()`;
  - inline module rewrite failure path.
- Runtime unit/static tests:
  - script-created inline text is not executed unrewritten;
  - script insertion hooks cover all activation methods;
  - import-map scripts are not treated as executable classic/module scripts;
  - dynamic HTML transform handles browser-parser edge cases without markup regex rewriting;
  - stealth membrane hides `data-zp-*` through attributes, serialized HTML, collections, traversal, and selectors;
  - `WebSocketStream` constructor exposes `opened`/`closed` promises and routes through patched `WebSocket`.
- Browser E2E tests:
  - transformed static `<a>` navigation lands on the intended target through ZeroProxy;
  - script-created inline `textContent` cannot observe proxy `/p/...#k=...` location;
  - module fixture using import map and `import.meta.url` loads through `/__zp/api/script` and observes target URL;
  - expression dynamic import loads target chunk through the script API;
  - malformed inline classic/event-handler source blocks in strict mode;
  - anti-fingerprinting fixture cannot enumerate `data-zp-*`, `#__zp-boot`, or `/__zp/` injected scripts through the enumerated DOM APIs;
  - `WebSocketStream` echo fixture uses the existing proxied WebSocket path.

### Gate 1: Runtime script element activation policy and structural dynamic HTML parser

Update `web/runtime-prelude.js` so script elements are normalized immediately before activation and dynamic HTML is transformed structurally.

Required changes:

- Add `prepareScriptElement(el)` and call it from every insertion hook before native insertion.
- If `el.src` is executable, route through `setScriptSource()`.
- If inline executable code exists, synchronously rewrite through the page-local rewriter when available; otherwise set an inert blocked type or replace content with a throwing strict block.
- Preserve non-executable script data blocks, including JSON and import maps.
- Ensure document fragments are recursively inspected before insertion.
- Keep `document.currentScript` behavior as close as practical for rewritten inline scripts.
- Replace `transformHTML()` regex markup rewriting with inert document parsing and tree traversal.
- Reuse captured native DOM APIs inside the transformer; do not call patched public APIs while building the transformed fragment.
- Recursively transform `srcdoc` without executing script or causing network fetches inside the inert document.

### Gate 1.5: Go kernel legitimate navigation recovery

Update `internal/htmltx/transform.go` to remove the frame-only assignment guard in `rewriteToken()`.

Required changes:

- In the `shouldRewriteAttr(tag, key)` branch, commit `a.Val = wrapped` and `dataTarget = target` for every successful `wrapAttrURL()` result.
- Preserve frame-specific activation behavior outside the assignment guard if frames need additional runtime handling.
- Keep blocked document-navigation behavior as `#` plus `data-zp-blocked-url`.
- Update `internal/htmltx/transform_test.go` with the Gate 0 navigation fixtures.
- Confirm no duplicate `data-zp-target-url`, `data-zp-blocked-url`, or `data-zp-integrity` attributes are emitted after the existing de-duplication pass.

### Gate 2: Import map and module resolver design

Add a single module-resolution contract shared by the HTML transformer, runtime prelude, and Service Worker rewriter.

Required changes:

- Introduce an import-map parser/normalizer for target documents.
- Transform static `<script type="importmap">` blocks in `internal/htmltx`.
- Transform dynamic import-map insertions in `runtime-prelude.js` before the browser observes them.
- Add a runtime helper for expression dynamic imports.
- Extend `web/js-rewriter.js` with specifier classification instead of `new URL()` on every specifier.
- Pass the original target module URL into every module rewrite operation and expose it to rewritten code for `import.meta.url` replacement.

### Gate 2.5: Anti-bot fingerprinting buffer and virtual DOM collections

Implement the stealth membrane for DOM attribute, serialization, collection, and traversal APIs.

Required changes:

- Add exact ZeroProxy artifact predicates:
  - `data-zp-*` attribute namespace;
  - `#__zp-boot`;
  - injected script assets whose `src` starts with `/__zp/` and are ZeroProxy-owned;
  - any other internal marker introduced by Phase 3 must be registered in the same predicate table.
- Patch attribute APIs on `Element.prototype`: `getAttribute`, `hasAttribute`, `getAttributeNames`, `attributes`, and any namespace variants that can expose `data-zp-*`.
- Patch serialization getters `innerHTML` and `outerHTML` to sanitize ZeroProxy artifacts without changing target-authored markup.
- Patch collection APIs:
  - `document.scripts`;
  - `Document.prototype.getElementsByTagName`;
  - `Element.prototype.getElementsByTagName`;
  - equivalent `getElementsByClassName` or selector surfaces only when they can expose ZeroProxy-owned injected assets.
- Patch traversal APIs:
  - `Document.prototype.createNodeIterator`;
  - `Document.prototype.createTreeWalker`;
  - iterator `nextNode()` / `previousNode()` must skip ZeroProxy-owned nodes while preserving traversal order for target nodes.
- Patch selector APIs for direct ZeroProxy-marker probes:
  - `querySelector`, `querySelectorAll`, `matches`, and `closest` must make selectors targeting `data-zp-*`, `#__zp-boot`, or exact internal script URLs return no ZeroProxy-owned nodes.
- Provide virtual `NamedNodeMap` / `HTMLCollection` / `NodeList` facades that preserve `length`, numeric indexing, `item()`, iteration, and method binding.
- Integrate every wrapper with `maskNativeFunction()` / existing native `toString` masking.
- Add tests for Turnstile-style probes: count scripts, list attributes, serialize DOM, traverse nodes, and query marker selectors.

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

### Gate 6.5: Streams API transport facade with `WebSocketStream`

Implement the `WebSocketStream` polyfill over the existing proxied `WebSocket` membrane.

Required changes:

- Remove `WebSocketStream` from the unconditional blocker list when the polyfill is installed.
- Install `root.WebSocketStream` only as a facade over `root.WebSocket`, never native networking.
- Resolve constructor URLs against the virtual location/base semantics used by `WebSocket`.
- Implement `opened` and `closed` promises with `ReadableStream` and `WritableStream` endpoints.
- Preserve binary behavior as close as practical: set `ws.binaryType = 'arraybuffer'`; pass messages through without unnecessary copies.
- Mask constructor/method stringification.
- Add browser E2E with an echo server proving stream writes/read events use the existing ZeroProxy WebSocket path.

## Verification plan

Run these after each gate that changes behavior:

```sh
npm run test:js
go test ./...
npm run test:e2e
```

Add targeted browser fixtures for:

- static `<a>`, `<form>`, and submitter navigation attributes;
- script-created inline text;
- dynamic document-fragment insertion containing scripts;
- parser-edge dynamic HTML (`srcdoc`, malformed attributes, raw-text-adjacent content, blocked links, integrity, event handlers);
- import map + bare module import;
- `import.meta.url` relative chunk loading;
- expression dynamic import;
- inline parse failure strict block;
- worker module import path;
- passthrough-policy disabled strict mode;
- stealth membrane probes for serialized HTML, attributes, collections, traversal, selectors, and native-function stringification;
- `WebSocketStream` echo over proxied WebSocket.

Verification claims must distinguish:

- static policy coverage;
- unit rewriter coverage;
- Go HTML-transform coverage;
- browser E2E runtime coverage;
- stealth-membrane observability coverage;
- transport-boundary coverage;
- strict-mode versus compatibility-mode behavior.

## Acceptance criteria

Phase 3 is accepted when all of the following are true:

- Static document-navigation attributes for `<a>`, `<area>`, `<form>`, `<input>`, `<button>`, `<iframe>`, and `<frame>` are rewritten or fail closed according to policy.
- A script element created with inline text cannot execute original target code outside the rewriter/membrane path.
- All script activation paths either rewrite, launder, or block before browser execution.
- Runtime dynamic HTML transformation no longer uses regex-based markup rewriting and passes parser-edge fixtures through the inert DOM traversal path.
- Bare module specifiers are not blindly converted to target-relative URLs.
- Import maps are transformed or honored well enough for bare specifier E2E fixtures.
- `import.meta.url` in rewritten modules exposes the original target module URL semantics required by relative chunk loading.
- Literal and expression dynamic imports load module chunks through `/__zp/api/script?kind=module&u=...` or fail closed for unsupported schemes.
- Rewriter scope tests prove `var` hoisting and lexical shadowing do not cause global helper rewrites for local bindings.
- Inline classic and event-handler rewrite failures fail closed in strict mode.
- Strict mode does not depend on unrewritten third-party passthrough scripts.
- Worker script imports remain routed through ZeroProxy, and blocked worker APIs are explicit in tests.
- Page scripts cannot observe ZeroProxy-owned `data-zp-*`, `#__zp-boot`, or injected `/__zp/` boot scripts through the DOM APIs enumerated in this plan.
- Internal ZeroProxy code still has access to required target URL, blocked URL, integrity, and boot metadata through captured native APIs or private metadata.
- `WebSocketStream` exists where required, exposes `opened`/`closed` stream semantics, and routes through the existing proxied WebSocket transport.
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
5. Stealth membrane scope:
   - recommended: commit to the enumerated ZeroProxy-artifact surfaces in this plan and add new surfaces only with tests; do not claim unbounded native-origin impersonation.
6. Dynamic HTML parser implementation:
   - recommended: remove regex markup rewriting entirely from `transformHTML()` and use inert DOM traversal as the only dynamic HTML policy path.
7. `WebSocketStream` native availability:
   - recommended: prefer the ZeroProxy facade whenever native `WebSocketStream` would escape the transport boundary; if native support can be safely wrapped later, gate it behind the same policy tests.
