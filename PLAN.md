# QuickJS Runtime With Go Network Worker Plan

## Goal

Improve JavaScript compatibility by moving target JavaScript execution into
QuickJS-NG, while keeping the existing Go WASM network engine and removing the
Service Worker.

Target shape:

- target JavaScript runs only inside QuickJS-NG;
- target navigation is virtual and never depends on native browser navigation;
- target resource loading never depends on a Service Worker;
- the existing Go WASM network engine remains the network authority;
- the Go WASM network engine runs in a normal browser Dedicated Worker when
  possible;
- the same Go WASM network engine can run on the foreground shell thread as a
  compatibility fallback;
- Rust WASM rewriter/codegen is removed from the target-JS hot path;
- Web API bridge coverage is measured against a real browser surface;
- Acid test progress is tracked as a first-class compatibility gate.

This plan supersedes the Rust `wreq`/Rust-smux/browser-network rewrite plan.
The immediate compatibility problem is JavaScript rewriting and browser API
emulation, not the already-working network transport.

## Non-Goals

- Do not port the network engine to Rust for this migration.
- Do not use browser `fetch` as a target-network fallback.
- Do not keep Service Worker interception as a hidden dependency.
- Do not run target scripts in the native browser `window`.
- Do not preserve `/zp/api/fetch`, `/zp/api/script`, or
  `/zp/api/worker-script` as target resource routes after cutover.
- Do not remove the Go server or current WebSocket/smux/SOCKS5/uTLS target
  transport during this migration.
- Do not attempt to pass Acid with fixture hacks. Acid progress must come from
  general DOM, CSSOM, event loop, resource loader, SVG/XML, and Web API bridge
  behavior.

## Target Architecture

```text
Host browser page at proxy origin
  - UI shell
  - existing share route display
  - native render backend
  - input/event capture
  - QuickJS runtime boot
  - GoNetworkBackend selection

QuickJS-NG WASM runtime
  - one realm per virtual browsing context
  - target classic scripts/modules/dynamic code
  - virtual Window/Document/DOM/Web APIs
  - task and microtask queues
  - module loader
  - dynamic compiler hooks

JS Web API stubs / virtual browser bridge
  - DOM, events, CSSOM, HTML, storage, history, location
  - fetch/XHR/WebSocket/EventSource/worker facades
  - resource loader
  - renderer mutation stream
  - Web API surface diagnostics

GoNetworkBackend
  - WorkerBackend: Dedicated Worker + wasm_exec.js + kernel.wasm
  - ForegroundBackend: same Go WASM kernel on the shell thread
  - identical request/stream/cookie/WebSocket API for both backends

Existing network path
  - Go WASM kernel
  - WebSocket/smux
  - SOCKS5
  - uTLS
  - target HTTP/WebSocket
```

Native browser APIs are used only by the ZeroProxy host shell. Target scripts
see virtual objects implemented by the bridge. The native DOM is a render
backend, not the target script's DOM.

## Key Design Decisions

### Remove Service Worker, Not The Go Network Engine

The current Service Worker owns request interception, routing, and the bridge to
Go WASM. In the new architecture, the virtual resource loader calls
`GoNetworkBackend` directly.

The Service Worker is removed because QuickJS-owned target execution no longer
needs native browser request interception. The Go network engine is retained
because it already owns the tested transport path:

```text
Go WASM kernel -> WebSocket/smux -> SOCKS5 -> uTLS -> target
```

### Prefer Dedicated Worker, Fall Back To Foreground

The network kernel should normally run in a normal browser Dedicated Worker:

```text
host shell
  -> WorkerBackend RPC
  -> network-worker.js
  -> wasm_exec.js
  -> kernel.wasm
  -> Go kernel exports
```

If Worker boot fails, stalls, crashes, or lacks required browser primitives, the
shell uses the same backend interface with foreground execution:

```text
host shell
  -> ForegroundBackend
  -> wasm_exec.js
  -> kernel.wasm
  -> Go kernel exports
```

Foreground mode is allowed to be slower and may introduce UI jank, but it must
preserve behavior. It is a compatibility fallback, not a separate network
implementation.

### Use One Backend Contract

QuickJS and the Web API stubs must not care whether networking runs in a
Dedicated Worker or on the foreground thread.

Backend API:

- `init({ servers })`;
- `fetchRaw(requestRecord)`;
- `openWebSocket(requestRecord)`;
- `setCookie(cookieRecord)`;
- `getDocumentCookie(cookieRecord)`;
- `cancel(requestId)`;
- `health()`;
- `shutdown()`.

`WorkerBackend` and `ForegroundBackend` must expose identical behavior,
response shapes, error classes, timing metadata, cancellation semantics, and
cookie behavior.

### Fetch Raw For QuickJS Documents

The old Service Worker path can ask the Go kernel to transform documents for
native browser execution. QuickJS-owned execution needs raw target bytes.

Add a raw-fetch mode to the Go kernel bridge:

- no HTML runtime injection;
- no script URL rewriting for native browser execution;
- no `/zp/api/script` generation;
- no document bootstrap injection;
- preserve response headers, status, final URL, cookies, and timing metadata;
- let the QuickJS virtual resource loader parse and execute the document.

Legacy transform mode may remain only during migration and must not be used by
the QuickJS path after cutover.

### Sanitize Before Native Rendering

Removing the Service Worker means the native browser must never see target
resource URLs in renderer-owned markup. Even if target JavaScript runs in
QuickJS, native parser/speculation features can still issue requests from HTML
and DOM state.

Use `golang.org/x/net/html` for the document/resource sanitizer. The sanitizer
is a separate boundary from the QuickJS DOM bridge:

```text
GoNetworkBackend.fetchRaw
  -> x/net/html tokenizer/tree pass
  -> virtual DOM/resource records
  -> explicit backend fetches
  -> renderer-safe blob/data/internal URLs
```

The sanitizer must block or neutralize browser-initiated hints:

- `<link rel="preconnect">`;
- `<link rel="dns-prefetch">`;
- `<link rel="prefetch">`;
- `<link rel="prerender">`;
- `<link rel="preload">`;
- `<link rel="modulepreload">`;
- HTTP `Link` headers with preload/preconnect/prefetch-like relations.

Major resource URLs must be resolved by the virtual resource loader, fetched
through `GoNetworkBackend`, and exposed to the native renderer only as owned
`blob:`, `data:`, or other renderer-safe internal URLs:

- image `src`, `srcset`, and `<picture>/<source>`;
- media `src`, `<source>`, `poster`, and track resources;
- stylesheet `href`;
- CSS `url(...)`, `@import`, fonts, and image references;
- favicon and app icon links;
- manifest links if supported;
- iframe/frame/object/embed URLs, which should become virtual browsing contexts
  or be blocked until implemented;
- script URLs, which must load into QuickJS and must not become native
  `<script src>`.

Favicon handling is explicit: target favicon discovery must not let the native
browser request the target icon. Either block the favicon or fetch it through
`GoNetworkBackend` and install a blob-backed shell favicon.

### No Native Target Navigation

The browser stays on the ZeroProxy shell origin. Target navigation is handled
inside the virtual browser core:

```text
virtual URL change
  -> navigation manager
  -> GoNetworkBackend.fetchRaw
  -> x/net/html parser/sanitizer
  -> new browsing context or same-document update
  -> QuickJS realm lifecycle
  -> renderer updates
```

Hard navigations create a fresh virtual `Window`, `Document`, global object, and
QuickJS context. Same-document navigations keep the realm and update virtual
`location`, `history`, scroll state, and events.

### Remove JS Rewriter From Target Script Execution

Target scripts should be loaded into QuickJS as source, not re-emitted for
native browser execution.

Allowed remaining parser/rewrite usage:

- HTML and CSS resource discovery;
- import map parsing if still useful;
- source metadata extraction;
- legacy compatibility tests during migration.

Disallowed after cutover:

- whole-program target JS codegen for browser execution;
- `/zp/api/script` module URL generation;
- target script execution through native `<script>` or native `import()`.

## New And Changed Components

### `runtime-rs` Or `quickjs-runtime`

QuickJS-NG WASM runtime component.

Responsibilities:

- build and link QuickJS-NG;
- create/destroy runtimes, contexts, and realms;
- expose host functions to QuickJS;
- preserve JS value identity across the bridge;
- root/unroot host objects safely;
- run QuickJS promise jobs;
- implement classic script and module evaluation;
- implement dynamic import hooks;
- implement dynamic code compiler hooks;
- expose diagnostics and surface snapshots.

### `web/host`

Native JS shell code.

Responsibilities:

- boot QuickJS runtime;
- select `WorkerBackend` or `ForegroundBackend`;
- create tabs and existing share routes;
- capture native input;
- translate native events into virtual event records;
- apply renderer mutation records to native DOM;
- manage blob URL lifetimes;
- drive animation/timer ticks;
- display errors and compatibility diagnostics.

### `web/network-worker`

Normal Dedicated Worker that hosts the existing Go WASM kernel.

Responsibilities:

- import or load `wasm_exec.js`;
- instantiate `kernel.wasm`;
- call `__zp_kernel_init`;
- expose RPC over `postMessage` and `MessagePort`;
- support streaming request and response bodies;
- support target WebSocket stream messages;
- support cancellation;
- report boot progress and health;
- crash/exit cleanly enough for foreground fallback.

### `GoNetworkBackend`

Shared JS adapter used by QuickJS Web API stubs.

Responsibilities:

- choose WorkerBackend first;
- fall back to ForegroundBackend on boot failure or unsupported Worker features;
- normalize request records into Go kernel-compatible inputs;
- normalize Go kernel responses into virtual browser response records;
- own request IDs and cancellation;
- expose timing metadata;
- keep error classes compatible with current tests;
- prevent raw browser network fallback.

### Go WASM Kernel

Keep `cmd/wasm-kernel`, but adapt its bridge surface.

Required changes:

- expose raw document/resource fetch mode;
- make document transformation optional and disabled for QuickJS requests;
- make bridge calls usable from a Dedicated Worker;
- support message/RPC friendly request and response records;
- support streaming or chunked ArrayBuffer transfer from Worker to shell;
- keep `__go_jshttp`, `__zp_stream`, `__zp_kernel_init`, and
  `__zp_cookie_set` during migration;
- add stable wrapper APIs only after characterization tests lock current
  behavior.

## Streaming Contracts And ABIs

All new boundaries must be versioned, incremental, and stream-capable from the
first implementation. A small non-streaming proof of concept is acceptable only
behind the same public envelope, so callers do not need to change when streaming
lands.

Shared rules for every boundary:

- Every message carries `v`, `type`, `id`, `tabId`, and optional `parentId`.
- Every stream carries a `streamId` and monotonic `seq`.
- Every protocol starts with `hello`/`ready` feature negotiation.
- Unknown fields must be ignored.
- Unknown required features must fail with a typed `unsupported_feature` error.
- Binary payloads must use transferable `ArrayBuffer` chunks by default.
- Transferable `ReadableStream`/`WritableStream` can be used only after feature
  negotiation; chunked ArrayBuffer transfer remains the required fallback.
- Backpressure is explicit: consumers send `stream.credit` or `stream.pause` /
  `stream.resume`, and producers must not buffer unbounded data.
- Cancellation is explicit: `cancel` is idempotent and must eventually produce
  either `complete` or `error`.
- Errors use stable machine-readable codes plus a debug string.
- Timing metadata is carried as structured records, not encoded in strings.
- WorkerBackend and ForegroundBackend must expose the same contract.

### GoNetworkBackend Message Protocol

Transport:

- WorkerBackend uses `postMessage` plus a dedicated `MessagePort`.
- ForegroundBackend uses the same message dispatcher in-process.
- Tests must run both backends against the same corpus and assert identical
  normalized messages.

Handshake:

```text
host -> backend: hello
backend -> host: ready
host -> backend: init
backend -> host: init.ok | init.error
```

`hello` fields:

- protocol version;
- supported binary modes: `arraybuffer-chunks`, `transferable-streams`;
- maximum chunk size;
- supported APIs: `fetchRaw`, `webSocket`, `cookie`, `timing`, `abort`;
- supported storage/cache APIs: `indexedDBStore`, `httpCache`, `cacheAPI`;
- backend kind requested: `worker` or `foreground`;
- relay server list from the existing share URL fragment.

Core message types:

- `fetch.start`;
- `fetch.body.chunk`;
- `fetch.body.end`;
- `fetch.response.start`;
- `fetch.response.chunk`;
- `fetch.response.end`;
- `fetch.error`;
- `fetch.cancel`;
- `ws.open`;
- `ws.accepted`;
- `ws.send`;
- `ws.message`;
- `ws.close`;
- `ws.error`;
- `cookie.get`;
- `cookie.get.result`;
- `cookie.set`;
- `cookie.set.result`;
- `stream.credit`;
- `stream.pause`;
- `stream.resume`;
- `stream.cancel`;
- `health.ping`;
- `health.pong`;
- `cache.match`;
- `cache.put`;
- `cache.revalidate`;
- `cache.evict`;
- `cache.clearPartition`;
- `cache.decision`;
- `storage.get`;
- `storage.set`;
- `storage.delete`;
- `storage.transaction`;
- `shutdown`.

`fetch.start` fields:

- `requestId`;
- `method`;
- `url`;
- `documentUrl`;
- `referrer`;
- `referrerPolicy`;
- `mode`;
- `credentials`;
- `redirect`;
- `cache`;
- `cacheKey`;
- `cacheMode`;
- `priority`;
- `headers` as ordered `[name, value]` pairs;
- optional request body stream metadata;
- `rawMode` set to `true` for QuickJS document/resource loading;
- `initiator`, such as `document`, `script`, `module`, `style`, `image`,
  `font`, `media`, `xhr`, `fetch`, `eventsource`, or `beacon`;
- `navigationId` when the request belongs to a navigation;
- `resourceId` when the request was produced by the sanitizer.

State machine:

```text
idle
  -> request_headers_sent
  -> request_body_streaming
  -> response_started
  -> response_body_streaming
  -> complete
  -> canceled/error
```

Rules:

- Header order must be preserved in the normalized record even if the Go HTTP
  internals later canonicalize names.
- Response body chunks must be delivered in order and never after
  `fetch.response.end`.
- `fetch.cancel` must abort request body upload, response body download, and the
  underlying Go kernel request where possible.
- `fetch.error` must include the stable error class used by current tests:
  `TARGET_CONNECT_FAILED`, `TARGET_PROTOCOL_BLOCKED`, `TLS_HANDSHAKE_FAILED`,
  `POLICY_BLOCKED`, `REQUEST_BODY_TOO_LARGE`, or another existing class unless
  a new class is explicitly added.

Target WebSocket stream rules:

- `ws.open` carries target URL, protocols, origin, document URL, tab isolation
  key, and relay server list.
- `ws.accepted` carries selected protocol, response headers, and timing.
- `ws.message` carries opcode-equivalent `text` or `binary`, payload, and seq.
- `ws.close` carries code, reason, clean/unclean flag, and source side.
- Backpressure and cancellation use the shared stream messages.

### `fetchRaw` Response Shape

`fetchRaw` is header-first and body-streamed. It returns raw target bytes plus
metadata; decoding and sanitization happen at the virtual resource layer unless
the caller explicitly requests a decoded helper.

`fetch.response.start` fields:

- `requestId`;
- `resourceId`;
- `navigationId`;
- `url`;
- `finalUrl`;
- `redirected`;
- `redirectChain`;
- `status`;
- `statusText`;
- `headers` as ordered `[name, value]` pairs;
- `mimeType`;
- `charset`;
- `contentLength`;
- `contentEncoding`;
- `bodyMode`: `arraybuffer-chunks` or `transferable-stream`;
- `bodyStreamId`;
- `timing`;
- `cookieWriteSummary`;
- `policy`;
- `cacheInfo` if available;
- `cacheDecision`;
- `cacheEntryId`;
- `networkBackend`: `worker` or `foreground`.

`fetch.response.chunk` fields:

- `bodyStreamId`;
- `seq`;
- `bytes`;
- `byteOffset`;
- `byteLength`;
- `final` when this is the last chunk in chunked fallback mode.

`fetch.response.end` fields:

- `bodyStreamId`;
- `bytesRead`;
- `timing`;
- `trailerHeaders` if present;
- `aborted`;
- `checksum` only for test/debug builds.

Policy:

- `fetchRaw` must not inject runtime HTML.
- `fetchRaw` must not rewrite target JavaScript.
- `fetchRaw` must not rewrite target CSS.
- `fetchRaw` must not construct `/zp/api/*` URLs.
- `fetchRaw` must preserve final URL and redirect metadata for virtual
  navigation.
- `fetchRaw` must expose enough headers for the sanitizer and resource loader to
  make content-type, charset, CSP, referrer-policy, and preload-link decisions.
- `fetchRaw` must report cache decisions even when the cache is bypassed.
- `fetchRaw` must stream cacheable response bodies through the cache manager
  without buffering the full body in memory.

### Sanitizer Output Schema

The sanitizer consumes `fetchRaw` response metadata and a byte/text stream. It
emits records, not native DOM. Native renderer mutations are produced only after
raw target URLs have been removed or replaced with resource references.

Common record fields:

- `v`;
- `type`;
- `docId`;
- `seq`;
- `sourceSpan` when available;
- `diagnostics` when the record blocks or alters target markup.

Record types:

- `document.start`;
- `document.base`;
- `document.meta`;
- `node.create`;
- `node.text`;
- `node.comment`;
- `node.attr`;
- `node.remove`;
- `resource.discovered`;
- `resource.blocked`;
- `resource.fetch.start`;
- `resource.blob.ready`;
- `script.inline`;
- `script.external`;
- `module.external`;
- `style.inline`;
- `style.external`;
- `event.inlineHandler`;
- `navigation.link`;
- `navigation.form`;
- `frame.virtualDocument`;
- `favicon.decision`;
- `document.end`.

`resource.discovered` fields:

- `resourceId`;
- `kind`: `script`, `module`, `style`, `image`, `font`, `media`, `track`,
  `favicon`, `manifest`, `iframe`, `object`, `embed`, `form`, `anchor`, `svg`,
  or `css-url`;
- `attribute`;
- `element`;
- `resolvedTargetUrl`;
- `baseUrl`;
- `initiatorNodeId`;
- `fetchPolicy`;
- `renderPolicy`: `blob`, `data`, `internal`, `virtual-navigation`, or `block`;
- `priority`;
- `srcsetCandidates` for `srcset` surfaces.

Renderer-safe node/attribute rules:

- Renderer records must never include `resolvedTargetUrl` in fields that will be
  copied to native DOM.
- Renderer records may include `resourceId`, `blobUrl`, `dataUrl`, or an
  internal URL generated by the resource loader.
- Anchor and area elements receive virtual-link metadata and a safe `href`
  value. Activation is handled by event listeners and the virtual navigation
  manager; raw target hrefs are stored only in virtual DOM state.
- Inline event handler attributes emit `event.inlineHandler` and are not copied
  into native DOM.
- External scripts and modules emit script records for QuickJS loading and are
  not copied into native `<script src>` or native module imports.

Streaming:

- The sanitizer may emit DOM records incrementally as tokens are parsed.
- Resource fetches may start before `document.end` when base URL state is known.
- If a later `<base>` changes resolution, it affects only subsequent URL
  resolution, matching browser behavior.
- Records that depend on full-tree context must declare `deferred: true` and
  emit a later update.

Diagnostics:

- Every blocked hint or resource gets a `resource.blocked` record.
- Every URL rewrite gets a test-visible diagnostic containing original
  attribute name, element name, resource kind, and policy decision.
- Diagnostics must be redacted before user-facing telemetry if privacy mode is
  reintroduced later.

### QuickJS Host ABI

The host ABI is the stable boundary between the shell, QuickJS runtime, virtual
browser, and GoNetworkBackend. It should be small, versioned, and stream-aware.

Host-created objects:

- `RuntimeHandle`;
- `TabHandle`;
- `BrowsingContextHandle`;
- `RealmHandle`;
- `DocumentHandle`;
- `ResourceHandle`;
- `StreamHandle`.

Shell-to-QuickJS calls:

- `runtime.create(options)`;
- `runtime.destroy(runtimeId)`;
- `tab.create({ shareRoute, targetUrl, servers, viewport, backendId })`;
- `tab.destroy(tabId)`;
- `navigation.start({ tabId, shareRoute, targetUrl, replace })`;
- `navigation.commit({ tabId, navigationId, sanitizerStreamId })`;
- `navigation.abort({ tabId, navigationId, reason })`;
- `script.evaluateClassic({ contextId, source, url, nonce, resourceId })`;
- `script.evaluateModule({ contextId, source, url, resourceId })`;
- `script.evaluateDynamic({ contextId, source, baseUrl, kind })`;
- `event.dispatch({ contextId, targetId, eventRecord })`;
- `viewport.update({ tabId, viewportRecord })`;
- `resource.deliver({ resourceId, blobUrl, metadata })`;
- `jobs.drain({ runtimeId, budget })`;
- `render.poll({ tabId, budget })`;
- `surface.snapshot({ tabId })`;

QuickJS-to-host imports:

- `host.fetchRaw(requestRecord)`;
- `host.openWebSocket(requestRecord)`;
- `host.cookieGet(record)`;
- `host.cookieSet(record)`;
- `host.createBlob(resourceRecord)`;
- `host.revokeBlob(blobId)`;
- `host.queueTask(taskRecord)`;
- `host.queueMicrotask(callbackRef)`;
- `host.requestAnimationFrame(callbackRef)`;
- `host.cancelAnimationFrame(handle)`;
- `host.now()`;
- `host.randomBytes(length)`;
- `host.console(level, args)`;
- `host.reportException(errorRecord)`;
- `host.surfaceProbe(query)`.

ABI rules:

- QuickJS object references crossing the boundary use opaque handles, not raw JS
  objects.
- Handles are realm-scoped unless explicitly marked cross-realm.
- Every handle has an owner and deterministic release path.
- Finalizers are a leak fallback, not primary ownership.
- Host exceptions are converted into browser-like DOMException/Error objects in
  QuickJS.
- QuickJS exceptions are reported to the shell without exposing native JS stack
  objects as target-visible values.
- All callbacks from host into QuickJS run through the virtual event loop.
- No host callback may call target JS reentrantly unless the ABI explicitly
  marks the operation as reentrant-safe.
- Module and dynamic-code loading must call the same sanitizer/resource loader
  used by static documents.
- Render mutations emitted by QuickJS must contain only virtual node IDs and
  renderer-safe resource references.

Incremental source handling:

- Network/resource streams may be incremental.
- QuickJS script evaluation starts only after the relevant source unit is
  complete and decoded.
- Module graph fetching can be concurrent, but evaluation follows ECMAScript
  module ordering and top-level-await semantics.
- Dynamic `eval`/Function source is compiled inside QuickJS after passing the
  same virtual resource/code policy hooks.

## Virtual Routing Model

Keep the existing share URL route format. Do not introduce a new virtual-route
namespace.

```text
/zp/p/<encrypted>#k=<key>[&server=<relay>...]
```

The encrypted path and fragment keep the current `web/zp-core.js`,
`internal/shareurl`, and Rust share URL behavior. The QuickJS architecture
changes the execution/runtime owner, not the external document URL shape.

The virtual navigation manager must continue to mint and consume existing share
routes through the current envelope:

- `ZP.encryptShareURL`;
- `ZP.makeSharePath`;
- `ZP.makeShareFragment`;
- `ZP.makeShareURL`;
- `ZP.shareRouteKey`;
- `internal/shareurl.NewWithServers`;
- `rewriter-rs` share URL helpers while they remain in use.

Native `history.pushState` may reflect the existing share route, but it must
never trigger native target fetches. Same-document navigation updates the
current share route/history state only when the target-visible browser behavior
requires it.

The navigation manager must handle:

- initial target load;
- anchors;
- forms;
- `location.href`;
- `location.assign`;
- `location.replace`;
- hash navigation;
- `history.pushState`;
- `history.replaceState`;
- back/forward traversal;
- `popstate`;
- `hashchange`;
- `window.open`;
- iframe navigation;
- meta refresh;
- HTTP redirects;
- downloads/resource classification.

## Web API Bridge Surface

Track bridge coverage with a machine-readable manifest:

```text
test/fixtures/webapi/bridge-surface.json
```

Each entry should include:

- interface name;
- exposure set;
- constructor presence;
- prototype chain;
- static properties;
- prototype properties;
- instance properties;
- constants;
- method arity;
- getter/setter shape;
- descriptor flags;
- brand-check behavior;
- stringification behavior;
- cross-realm behavior;
- implementation status;
- Acid relevance;
- WPT/idlharness relevance;
- intentionally blocked reason, if blocked.

Implementation status values:

- `implemented`;
- `partial`;
- `stub-compatible`;
- `blocked-by-policy`;
- `not-started`;
- `not-required-for-acid`;
- `unknown`.

## Web API Surface Comparator

Add scripts:

```text
scripts/snapshot-browser-surface.mjs
scripts/snapshot-quickjs-surface.mjs
scripts/compare-webapi-surface.mjs
scripts/probe-webapi-behavior.mjs
```

Comparator outputs:

```text
test/fixtures/webapi/chromium-surface.json
test/fixtures/webapi/quickjs-surface.json
test/fixtures/webapi/webapi-gap-report.json
test/fixtures/webapi/webapi-gap-report.md
```

Gap categories:

- missing interface;
- missing constructor;
- missing prototype member;
- missing instance member;
- wrong descriptor;
- wrong arity;
- wrong prototype chain;
- wrong brand check;
- wrong cross-realm identity;
- wrong event timing;
- present but policy-blocked;
- intentionally absent;
- Acid-blocking gap;
- framework-blocking gap.

### Full Browser API Surface Audit

The virtual browser must be driven by a full API surface comparison, not by
hand-written TODO lists alone. The comparator should snapshot Chromium and the
QuickJS virtual browser under the same test page shape and produce a diff that
implementation work can follow.

Snapshot all practical surface categories:

- `globalThis` own property names and symbols;
- `Window`/`WindowProxy` visible properties;
- constructors and constructor descriptors;
- static members;
- prototype chains;
- prototype own property names and symbols;
- instance property names and symbols for representative objects;
- property descriptors, including writable/enumerable/configurable;
- accessor vs data property shape;
- method `.name` and `.length`;
- constants and enum-like numeric/string values;
- `Symbol.toStringTag`;
- `Object.prototype.toString.call(value)` output;
- `Function.prototype.toString` native-looking behavior;
- brand-check behavior for methods/getters/setters;
- cross-realm identity and `instanceof`;
- iterable behavior;
- callback invocation shape;
- event class inheritance;
- error names/messages where stable enough to compare;
- unsupported/policy-blocked APIs with explicit reason codes.

Use browser IDL data where practical. The target comparison set should include
at least:

- DOM Core;
- HTML;
- Events;
- UI Events;
- CSSOM;
- URL;
- Encoding;
- Fetch;
- XHR;
- Streams;
- WebSocket/EventSource;
- File/Blob/FormData;
- Storage;
- History/Location;
- Navigator;
- Selection/Range/Traversal;
- Mutation/Resize/Intersection observers;
- SVG/XML surfaces needed by Acid and real pages;
- Worker-related globals once target workers are implemented.

The behavior probe must test more than presence:

- constructor call vs `new` behavior;
- illegal invocation errors;
- getter/setter receiver checks;
- mutation side effects;
- collection liveness;
- event dispatch timing;
- promise/microtask timing;
- structured clone behavior;
- URL parsing/serialization;
- fetch/XHR header/body semantics;
- storage quota/error shape where feasible;
- focus/selection state transitions;
- form submission/default action hooks.

Every comparator gap must be classified:

- implement now;
- Acid-blocking;
- framework-blocking;
- site-compat long tail;
- acceptable policy block;
- out of current scope;
- browser-version drift.

Rules:

- No Web API should be marked complete without a comparator entry.
- No intentional absence should be hidden; it must appear as an explicit
  `blocked-by-policy` or `out-of-scope` manifest entry.
- CI should fail on new Acid-blocking or framework-blocking gaps unless the
  manifest explicitly accepts the temporary gap with an owner note.
- Comparator output should be reviewable markdown plus machine-readable JSON.

## Minimum Web API Implementation List

### ECMAScript Host Integration

QuickJS-NG covers the ECMAScript engine, but ZeroProxy must implement:

- browser global object creation;
- global aliases;
- module loader;
- import maps if retained;
- dynamic import;
- top-level await integration;
- promise job draining;
- error stacks;
- source URLs;
- host exception conversion;
- `queueMicrotask`;
- `structuredClone`;
- `crypto.getRandomValues`;
- `atob` and `btoa`;
- `console`;
- `performance.now`.

### DOM, Events, HTML, And CSSOM

Implement enough to run real pages and Acid:

- `Window`;
- `Document`;
- `Node`;
- `Element`;
- `HTMLElement`;
- `Text`;
- `Comment`;
- `DocumentFragment`;
- `Attr`;
- `NodeList`;
- `HTMLCollection`;
- live collections;
- namespaces;
- `innerHTML`/`outerHTML`;
- `DOMParser`;
- `XMLSerializer`;
- `document.write`;
- `Range`;
- `Selection`;
- `TreeWalker`;
- `NodeIterator`;
- `MutationObserver`;
- `EventTarget`;
- event propagation;
- mouse/pointer/keyboard/input/focus events;
- event listener registration/removal compatibility;
- IDL `on*` event handler properties;
- inline event handler attributes compiled into QuickJS functions;
- forms and form controls;
- anchors and URL reflection;
- images/scripts/links/styles;
- iframes;
- tables;
- dataset/classList/style reflection;
- shadow DOM and custom elements as a later compatibility milestone;
- layout/readback APIs such as `getBoundingClientRect`, `clientWidth`,
  `offsetWidth`, scroll positions, and viewport metrics;
- `CSSStyleDeclaration`;
- stylesheet loading;
- `getComputedStyle`;
- `matchMedia`;
- CSS resource URL extraction.

### Viewport, Resize, And Layout Compatibility

The virtual browser must react to host browser resize and viewport changes like
a real page. This is required for responsive layouts, framework hydration,
virtualized lists, canvas sizing, media queries, and Acid-style visual tests.

Implement:

- host viewport observation for width, height, device pixel ratio, orientation,
  visual viewport offsets, and zoom-relevant values where available;
- virtual `window.innerWidth`, `innerHeight`, `outerWidth`, `outerHeight`,
  `devicePixelRatio`, `screen`, and `visualViewport` surfaces;
- `resize` events on virtual `Window`;
- `orientationchange` behavior when applicable;
- `matchMedia` and `MediaQueryList` change events;
- CSS media query invalidation and style recalculation triggers;
- layout/readback APIs such as `getBoundingClientRect`, `getClientRects`,
  `clientWidth`, `clientHeight`, `offsetWidth`, `offsetHeight`, `scrollWidth`,
  `scrollHeight`, scroll positions, and viewport metrics;
- `ResizeObserver` delivery ordering;
- `IntersectionObserver` delivery based on the native render backend geometry;
- `requestAnimationFrame` timing around resize/layout updates;
- focus and selection preservation across resize when native browser behavior
  would preserve it.

Rules:

- Native resize events must be converted into virtual browser tasks before
  target JavaScript observes them.
- `matchMedia` listeners and CSS recalculation must observe the same virtual
  viewport state.
- Layout readback must not expose native DOM nodes or raw target URLs.
- Resize, observer delivery, and `requestAnimationFrame` ordering must be
  covered by behavior probes, not only final pixel checks.
- WorkerBackend and ForegroundBackend must produce the same resource behavior
  across resize-triggered loads.

### Event Listener Compatibility

Event listeners must match browser JavaScript behavior closely. Frameworks rely
on listener ordering, identity, propagation, option semantics, and reentrancy in
ways that are easy to break with a shallow bridge.

Implement:

- `addEventListener`, `removeEventListener`, and `dispatchEvent` on every
  virtual `EventTarget`;
- listener identity rules by callback object and capture flag;
- duplicate registration suppression;
- removal during dispatch without corrupting the active listener snapshot;
- adding listeners during dispatch with browser-compatible visibility timing;
- callback functions and `{ handleEvent() {} }` listener objects;
- `capture`, `once`, `passive`, and `signal` options;
- boolean third-argument compatibility;
- `AbortSignal` listener removal;
- `stopPropagation`;
- `stopImmediatePropagation`;
- `preventDefault`;
- `defaultPrevented`;
- cancelable vs non-cancelable events;
- composed path and event phase values;
- `target`, `currentTarget`, `eventPhase`, `isTrusted`, `timeStamp`;
- correct `this` binding for listener callbacks;
- cross-realm listener objects and brand checks;
- exception reporting without stopping unrelated listeners except where the DOM
  standard requires it;
- nested/reentrant event dispatch;
- microtask checkpoint ordering around event tasks;
- native input event translation into virtual events before target code runs.

Implement IDL event handler properties:

- `onclick`, `onload`, `onerror`, `oninput`, `onchange`, `onsubmit`, and other
  relevant `on*` properties on `Window`, `Document`, elements, and form
  controls;
- assignment/removal behavior for `null`, functions, and non-functions;
- ordering relative to `addEventListener` listeners;
- descriptor shape and enumerability matching browser surfaces where practical.

Implement inline event handler attributes:

- parse attributes such as `onclick="..."` during HTML sanitization;
- compile handler source inside QuickJS, never native browser JS;
- preserve browser-like handler parameters, especially the implicit `event`;
- bind `this` to the current element;
- expose the expected scope chain for element/document/window names where
  supported by the virtual DOM;
- route return `false` to default-prevention for compatible handler types;
- never copy inline handler attributes into native DOM.

Testing requirements:

- focused unit tests for listener identity, duplicate suppression, removal,
  `once`, `passive`, `signal`, and boolean capture;
- focused unit tests for listener mutation during dispatch and nested dispatch;
- focused unit tests for callback `this`, `currentTarget`, target, event phase,
  propagation stops, and default prevention;
- focused unit tests for IDL `on*` property ordering and removal;
- focused unit tests for inline handler compilation in QuickJS;
- e2e framework smoke tests covering React/Vue/Svelte-style delegated events;
- e2e tests proving native DOM has no target inline handler attributes.

### Network APIs

Implement through `GoNetworkBackend`:

- `fetch`;
- `Request`;
- `Response`;
- `Headers`;
- XHR;
- EventSource;
- WebSocket;
- `navigator.sendBeacon`;
- redirects;
- credentials modes;
- referrer/referrer-policy;
- abort handling;
- streaming request/response bodies where possible;
- resource timing metadata.

### Storage, Cookies, And History

Implement:

- `document.cookie` through Go kernel cookie APIs;
- cookie jar behavior keyed by virtual origin and tab isolation;
- IndexedDB-backed persistent storage as the canonical client-side state store;
- `localStorage` backed by IndexedDB with synchronous facade semantics inside
  QuickJS;
- `sessionStorage` backed by per-tab/per-top-level-context IndexedDB records or
  an in-memory mirror with IndexedDB snapshotting where needed;
- IndexedDB API facade for target pages after the storage engine is stable;
- Cache API facade backed by the same cache manager, while Service Workers
  remain unsupported;
- HTTP cache storage and validation metadata;
- history stack;
- `location`;
- `origin`;
- `navigator`;
- selected screen/device properties;
- permissions stubs;
- `crypto`;
- `Clipboard`/clipboard policy stubs if exposed;
- `Permissions` API stubs;
- `Screen`, viewport, device pixel ratio, and media capability surfaces where
  required by framework probes;
- target `navigator.serviceWorker` facade that reports unsupported
  registration without exposing native Service Worker control.

### IndexedDB Storage And Cache Manager

Use browser IndexedDB as the durable storage substrate for virtual browser
state. Do not store target-origin state directly in native origin-global
`localStorage`, `sessionStorage`, or Cache Storage; those APIs belong to the
proxy shell origin and do not provide the required virtual-origin partitioning.

Storage partitions:

- virtual origin;
- top-level share route/tab ID;
- browsing context ID;
- relay/server isolation key where relevant;
- storage type: cookies, localStorage, sessionStorage, IndexedDB, HTTP cache,
  Cache API, blob registry metadata.

IndexedDB database shape:

- database name: `zeroproxy-virtual-browser`;
- versioned schema migrations;
- object stores:
  - `origins`;
  - `tabs`;
  - `cookies`;
  - `localStorage`;
  - `sessionStorage`;
  - `indexedDBCatalog`;
  - `indexedDBObjectData`;
  - `httpCacheEntries`;
  - `httpCacheBodies`;
  - `cacheApiMetadata`;
  - `cacheApiBodies`;
  - `blobRegistry`;
  - `quotaUsage`;
  - `schemaMeta`.

Rules:

- Every key includes the virtual origin and storage partition.
- Schema upgrades must be forward-only and tested with old-version fixtures.
- Storage writes must be transactional where browser semantics require atomic
  visibility.
- Large response bodies must be chunked rather than stored as one giant value.
- Body chunks need reference counting or explicit ownership so cache eviction
  cannot delete a body still used by a live blob/resource.
- Storage access from QuickJS is asynchronous internally, but `localStorage`
  must expose synchronous target semantics through a per-origin mirror loaded
  before script execution.
- `storage` events must be delivered to other same-virtual-origin contexts when
  `localStorage` changes.
- Session storage is scoped to the virtual top-level browsing context and must
  survive same-document navigations, but not unrelated share-route tabs.
- All storage APIs must enforce quota and expose browser-like error names where
  practical.

HTTP cache policy:

- Respect request cache modes: `default`, `no-store`, `reload`, `no-cache`,
  `force-cache`, and `only-if-cached` where compatible with fetch mode.
- Respect response directives: `Cache-Control`, `Pragma`, `Expires`, `ETag`,
  `Last-Modified`, `Vary`, `Age`, `Date`, `Location`, and status-code cache
  defaults.
- Never store responses to requests with `no-store`.
- Never reuse cached entries across virtual origins or credential partitions.
- Include request method, URL, selected request headers from `Vary`,
  credentials mode, top-level site/share partition, and redirect policy in the
  cache key where needed.
- Revalidate stale entries with `If-None-Match` and `If-Modified-Since`.
- Merge `304 Not Modified` metadata correctly.
- Track redirect-chain cacheability separately from final response cacheability.
- Cache opaque/policy-blocked responses only if a future explicit policy allows
  it; default to not storing them.
- Do not allow native browser HTTP cache to become a target resource cache.
  Target cache decisions belong to the virtual cache manager.

Cache manager API:

- `cache.match(requestRecord)`;
- `cache.put(requestRecord, responseMetadata, bodyStream)`;
- `cache.revalidate(entry, requestRecord)`;
- `cache.delete(cacheKey)`;
- `cache.evict(policy)`;
- `cache.clearPartition(partitionKey)`;
- `cache.usage(partitionKey)`;
- `cache.explainDecision(requestRecord, responseRecord)`.

Cache API facade:

- Implement `caches.open`, `caches.match`, `caches.delete`, `caches.keys`, and
  `Cache.match`/`put`/`delete`/`keys` on top of the virtual cache stores.
- Keep Service Worker registration unsupported; Cache API support does not
  imply Service Worker support.
- Preserve `Request`/`Response` cloning and body-use semantics.

Eviction and management:

- Maintain per-origin and global byte quotas.
- Prefer LRU eviction among HTTP cache and Cache API bodies.
- Never evict active response/body/blob handles.
- Expose development diagnostics for cache hits, misses, revalidations,
  stores, skips, and evictions.
- Add a shell-side cache/storage management panel or debug command before broad
  site testing, with controls for per-origin clear, full clear, quota display,
  and cache decision inspection.

### Workers And Realms

Implement after top-level page viability:

- dedicated target workers as separate QuickJS runtimes or contexts;
- worker event loop;
- `postMessage`;
- `MessageChannel`;
- structured clone;
- `importScripts`;
- module workers;
- SharedWorker only after dedicated workers are stable.

Service Workers remain unsupported for target pages in this architecture.

## Acid Test Plan

Add local fixtures:

```text
test/fixtures/acid/
test/e2e/acid.test.js
```

Harness requirements:

- native Chromium baseline;
- ZeroProxy QuickJS virtual runtime run;
- screenshot capture;
- DOM-visible score capture where available;
- console/error capture;
- network/resource trace capture;
- Web API gap annotations for each failure.

Acid gates:

1. Acid fixture loads without crashing QuickJS.
2. No raw target resource is requested by native browser APIs.
3. Score-producing Acid tests report the expected score.
4. Screenshot matches native baseline within a fixed tolerance.
5. Gap report has no `Acid-blocking` missing APIs.

## Migration Phases

### Phase 0: Baseline And Inventory

Status: branch created as `quickjs-virtual-routing-plan`.

Tasks:

- keep this plan as the architectural tracker;
- inventory all Service Worker, `/zp/api/*`, Rust JS rewriter, and Go WASM
  bridge dependencies;
- snapshot current Go WASM network behavior;
- snapshot current Service Worker request classification behavior;
- freeze current Go kernel bridge behavior with characterization tests.

Exit criteria:

- current behavior inventory is complete;
- no removal has happened yet;
- Go network behavior is characterized before moving it into a Worker.

### Phase 1: GoNetworkBackend Adapter

Tasks:

- implement the versioned message envelope;
- implement `hello`/`ready` feature negotiation;
- define request/response/WebSocket/cookie/timing records;
- define storage/cache records and cache decision records;
- implement chunked ArrayBuffer stream fallback;
- negotiate transferable streams only as an optional fast path;
- implement stream credit/backpressure and idempotent cancellation;
- implement `WorkerBackend` boot path;
- implement `ForegroundBackend` boot path;
- add backend health checks;
- add boot timeout and fallback selection;
- prove both backends call the same Go kernel exports;
- add tests that both backends produce identical normalized records.

Exit criteria:

- the shell can use either backend through the same API;
- foreground fallback works without Service Worker;
- chunked streaming and cancellation work in both backends;
- message protocol fixtures cover fetch, WebSocket, cookie, health, shutdown,
  cache, storage, error, and cancellation flows;
- no target request uses native browser `fetch`.

### Phase 2: Service Worker Removal Shell

Tasks:

- remove Service Worker registration from `web/index.html`;
- stop relying on `navigator.serviceWorker.controller`;
- route shell startup directly through host JS;
- serve network worker assets as normal static assets;
- keep `/zp/ws-pipe` or current relay endpoint for Go WASM transport;
- remove `/zp/api/*` dependencies from the new path.

Exit criteria:

- shell boots without registering a Service Worker;
- Go network Worker can initialize;
- foreground backend can initialize when Worker boot is forced to fail.

### Phase 3: QuickJS-NG Build And Host Bridge

Tasks:

- vendor or pin QuickJS-NG;
- build QuickJS as WASM;
- implement the initial QuickJS host ABI envelope and handle table;
- execute classic script source;
- execute module source;
- drain promise jobs;
- call host functions from QuickJS;
- expose host objects to QuickJS;
- preserve wrapper identity;
- tear down a realm without leaking handles.

Exit criteria:

- one virtual realm can run JavaScript without native eval;
- host calls work in both directions;
- host handles have deterministic ownership and release tests;
- memory lifecycle has focused tests.

### Phase 4: Virtual Event Loop And Navigation

Tasks:

- implement task queue;
- implement microtask queue;
- integrate QuickJS promise jobs;
- implement timers;
- implement `queueMicrotask`;
- implement hard navigation realm reset;
- implement same-document navigation realm preservation;
- implement error propagation and console capture.

Exit criteria:

- ordering tests pass for promises, timers, events, and navigation teardown;
- hard navigation creates a new realm;
- same-document navigation preserves the realm.

### Phase 5: Resource Sanitizer And Loader

This phase is mandatory before deleting the Service Worker. The objective is to
make the native browser renderer incapable of discovering raw target resource
URLs, even through parser speculation, preload scanners, favicon discovery, or
renderer-owned DOM attributes.

Implementation rules:

- Run the sanitizer before any target HTML, target DOM mutation, or target
  resource attribute reaches native DOM.
- Use `golang.org/x/net/html` for HTML tokenization/tree handling.
- Emit the sanitizer output schema defined above; do not emit native DOM nodes.
- Treat URL-bearing HTML/CSS surfaces as deny-by-default.
- Resolve target URLs against the virtual document final URL and virtual
  `<base>` state, not against the proxy shell URL.
- Never copy raw target URLs into native `src`, `srcset`, `href`, `poster`,
  `data`, `action`, `formaction`, `manifest`, `style`, or SVG URL attributes.
- Preserve the existing share URL document route format for document
  navigations: `/zp/p/<encrypted>#k=<key>[&server=...]`.
- Use `GoNetworkBackend` for every target resource fetch.
- Expose fetched renderer resources only as owned `blob:`, safe `data:`, or
  internal renderer URLs.
- Track every generated blob URL in a per-document registry and revoke it when
  the owning virtual document/element is destroyed.
- Never use native browser `fetch` as a resource fallback.

HTML sanitizer inputs:

- target document URL;
- final response URL after redirects;
- response headers;
- decoded HTML bytes/string;
- document charset;
- active share route metadata;
- relay server list from the existing share URL fragment.

HTML sanitizer outputs:

- virtual DOM construction records;
- resource fetch records;
- sanitized renderer mutation records;
- blocked-resource diagnostics;
- native-safe favicon decision;
- native-safe metadata for tests and telemetry.

Block or neutralize browser-initiated hints:

- `<link rel="preconnect">`;
- `<link rel="dns-prefetch">`;
- `<link rel="prefetch">`;
- `<link rel="prerender">`;
- `<link rel="preload">`;
- `<link rel="modulepreload">`;
- HTTP `Link` headers with preload, preconnect, dns-prefetch, prefetch,
  prerender, or modulepreload relations.

Resource rewrite instructions:

- Classic scripts: fetch with `GoNetworkBackend`, then execute source in
  QuickJS. Do not create native `<script src>`.
- Module scripts: fetch and resolve through the QuickJS module loader. Do not
  create native module imports.
- Stylesheets: fetch with `GoNetworkBackend`, parse CSS URLs, fetch referenced
  resources through `GoNetworkBackend`, and rewrite CSS `url(...)`/`@import`
  outputs to blob/internal URLs before native style insertion.
- Images: rewrite `img[src]`, `img[srcset]`, `<picture>`, and `<source>` image
  candidates to fetched blob/internal URLs. Preserve `srcset` descriptors after
  URL replacement.
- Media: rewrite `audio/video/source[src]`, `poster`, and track resources to
  fetched blob/internal URLs.
- Fonts: fetch through `GoNetworkBackend` and expose only blob/internal font
  URLs in native CSS.
- Favicon/app icons: block by default, or fetch through `GoNetworkBackend` and
  install a blob-backed shell favicon. Native browser favicon discovery must not
  request the target origin.
- Manifest: block until virtual manifest support exists; if supported later,
  fetch through `GoNetworkBackend`, sanitize nested icon/start_url/scope fields,
  and expose only a blob/internal manifest URL.
- Iframe/frame document URLs: create virtual browsing contexts using the
  existing share URL envelope. Do not set native iframe `src` to a raw target
  URL.
- Object/embed URLs: block until explicit virtual resource semantics exist.
- Form `action`/`formaction`: keep only as virtual submission targets. Do not
  expose raw action URLs to native form submission.
- Anchors/areas: keep as virtual navigation targets. User activation must route
  through the virtual navigation manager and existing share URL envelope.
- SVG URL attributes and `xlink:href`: apply the same deny-by-default URL
  handling as HTML attributes.

Testing instructions:

- Unit-test `x/net/html` sanitizer behavior for every URL-bearing attribute
  class above.
- Unit-test `srcset` parsing and descriptor preservation.
- Unit-test case-insensitive and token-list `rel` handling.
- Unit-test HTTP `Link` header neutralization.
- Unit-test favicon block and blob replacement modes.
- Unit-test blob registry ownership and revocation.
- E2E-test top-level navigation, redirects, history updates, and iframe
  navigations to prove they keep the existing `/zp/p/<encrypted>#k=<key>` URL
  shape.
- E2E-test that no replacement document-route namespace is introduced.
- E2E-test browser request logs to prove native browser never requests
  target-origin preconnect, preload, prefetch, favicon, image, stylesheet, font,
  media, script, iframe, object, embed, form, manifest, or SVG resource URLs.
- E2E-test that disabling WorkerBackend and forcing ForegroundBackend preserves
  the same sanitizer/resource behavior.

Exit criteria:

- A real target document can load without Service Worker interception.
- Target scripts execute in QuickJS only.
- No native DOM resource points at a raw target URL.
- No native browser request log contains raw target-origin preconnect, preload,
  prefetch, favicon, image, stylesheet, font, media, script, iframe, object,
  embed, form, manifest, or SVG resource requests.
- Top-level and child document routes keep the existing share URL format.

### Phase 6: Virtual DOM Core And Renderer

Tasks:

- implement DOM node classes;
- implement document creation;
- implement mutation operations;
- implement attributes and namespaces;
- implement live collections;
- implement `EventTarget` listener storage and dispatch;
- implement IDL `on*` event handler properties;
- compile inline event handler attributes into QuickJS functions;
- translate native renderer/input events into virtual events before dispatch;
- implement viewport state synchronization from the host browser;
- implement virtual resize, media query, observer, and layout readback updates;
- implement renderer mutation stream;
- render a basic HTML document through the native backend;
- forward native input events as virtual events.

Exit criteria:

- target JS can create and mutate visible DOM;
- target JS never receives native DOM objects;
- event listeners, IDL handlers, and inline handlers execute only in QuickJS;
- listener ordering, propagation, options, reentrancy, and default-prevention
  tests pass;
- resize, media query, layout readback, `ResizeObserver`,
  `IntersectionObserver`, and `requestAnimationFrame` ordering tests pass;
- renderer mutations are deterministic and testable.

### Phase 7: Network API Stubs

Tasks:

- implement `fetch` on top of `GoNetworkBackend.fetchRaw`;
- implement `Request`, `Response`, and `Headers`;
- implement request cache modes through the virtual HTTP cache manager;
- implement XHR;
- implement EventSource;
- implement WebSocket on top of Go kernel stream support;
- implement cookie reads/writes;
- implement abort/cancellation;
- implement timing metadata.

Exit criteria:

- framework smoke tests can perform HTTP and WebSocket operations;
- WorkerBackend and ForegroundBackend pass the same network API tests;
- cache policy tests pass for request modes, response directives,
  revalidation, Vary, redirects, and partitioning;
- error classes match the current Go/SW path where applicable.

### Phase 8: Web API Bridge Expansion

Tasks:

- implement the minimum Web API list above;
- mark every implemented API in `bridge-surface.json`;
- run the full browser API surface comparator after each interface group;
- run behavior probes for each implemented interface family;
- add focused bridge tests for descriptors, brand checks, and timing;
- keep intentionally blocked APIs explicit.

Exit criteria:

- Web API gap report is actionable;
- every implemented Web API has a comparator entry and behavior probe coverage;
- no hidden missing APIs remain outside the manifest classification system;
- Acid-blocking APIs have owner tasks;
- framework smoke fixtures can run basic apps.

### Phase 9: Acid Compatibility Push

Tasks:

- run Acid fixtures after DOM/CSS/event/resource milestones;
- map each failure to a manifest gap;
- implement Range/Traversal/CSSOM/SVG/XML gaps needed by Acid;
- add screenshot comparison;
- add event-loop ordering assertions for Acid-sensitive cases.

Exit criteria:

- Acid fixture score reaches the target score;
- screenshot comparison passes;
- no Acid-blocking Web API gaps remain.

### Phase 10: Remove Native JS Rewriter Hot Path

Tasks:

- stop rewriting target JS for native browser execution;
- remove `/zp/api/script` generation from the new path;
- remove module URL rewriting needed only by native browser modules;
- move dynamic code handling into QuickJS compile hooks;
- keep only HTML/CSS/resource parsing utilities if still useful.

Exit criteria:

- target scripts are loaded as source into QuickJS;
- dynamic source compiles through QuickJS hooks;
- native browser never imports or executes target JS.

### Phase 11: Delete Legacy Service Worker Path

Tasks:

- delete `web/sw.js`;
- delete `web/sw-entry.mjs`;
- delete `web/sw/*`;
- remove Service Worker routes from the Go server;
- remove `/zp/api/fetch`, `/zp/api/script`, and `/zp/api/worker-script`;
- update tests that asserted Service Worker control;
- keep target `navigator.serviceWorker` as an unsupported virtual facade.

Exit criteria:

- no browser asset registers or depends on a Service Worker;
- no target request path depends on Service Worker interception;
- e2e tests pass through existing `/zp/p/<encrypted>#k=<key>` share routes and
  GoNetworkBackend.

## Verification Plan

Add or update npm scripts:

```text
npm run test:webapi-surface
npm run test:webapi-behavior
npm run test:acid
npm run test:quickjs
npm run test:network-worker
```

Keep existing gates during migration:

```text
npm test
npm run lint
cargo test --manifest-path rewriter-rs/Cargo.toml
npm run test:wasm
```

Additional required tests:

- GoNetworkBackend protocol fixture tests for `hello`, `ready`, `init`,
  `fetchRaw`, WebSocket, cookie, health, shutdown, error, and cancellation
  flows;
- stream transport tests for ArrayBuffer chunk fallback, transferable stream
  negotiation, backpressure credits, pause/resume, cancellation, and ordering;
- `fetchRaw` response-shape tests for header ordering, redirect metadata, final
  URL, timing, body chunks, trailers, errors, and abort behavior;
- IndexedDB schema migration tests with old-version fixtures;
- storage partitioning tests for virtual origin, tab, browsing context, and
  session lifetime;
- localStorage synchronous mirror tests and cross-context `storage` event tests;
- target IndexedDB facade tests once exposed to pages;
- HTTP cache policy tests for `Cache-Control`, `Pragma`, `Expires`, `ETag`,
  `Last-Modified`, `Vary`, `Age`, `Date`, cache modes, `304` merge behavior,
  redirects, credential partitioning, and no-store bypass;
- Cache API facade tests for `caches.open`, `match`, `put`, `delete`, `keys`,
  cloning, body-use, quota, and eviction;
- cache manager streaming tests proving cacheable bodies are stored
  incrementally and active body/blob handles are not evicted;
- sanitizer output schema tests for record ordering, `resourceId` stability,
  virtual link records, inline handler records, blob-ready updates, deferred
  records, and diagnostics;
- QuickJS host ABI tests for handle ownership, release, cross-realm handles,
  host exception conversion, callback reentrancy guards, task scheduling, and
  render mutation safety;
- WorkerBackend boot and RPC tests;
- ForegroundBackend boot and RPC tests;
- Worker-to-foreground fallback tests;
- backend differential tests over the same generated request corpus;
- raw-fetch document tests;
- `x/net/html` sanitizer tests for resource attributes, srcset, icon links, and
  preload/preconnect relations;
- e2e share-route tests proving top-level navigation, redirects, history
  updates, and iframe navigations keep the existing `/zp/p/<encrypted>#k=<key>`
  URL shape;
- e2e tests proving the new runtime does not introduce any replacement
  document-route namespace;
- e2e request-log tests proving native browser never requests target-origin
  preconnect, preload, prefetch, favicon, image, stylesheet, font, media,
  script, iframe, object, embed, form, manifest, or SVG resource URLs;
- streaming response tests;
- cancellation tests;
- target WebSocket tests;
- cookie parity tests;
- QuickJS host object lifetime tests;
- event loop ordering tests;
- event listener compatibility tests for identity, ordering, options,
  propagation, reentrancy, `on*` properties, inline handlers, and
  framework-style delegated events;
- viewport/resize tests for `innerWidth`, `innerHeight`, `devicePixelRatio`,
  `screen`, `visualViewport`, `resize`, `matchMedia`, CSS media queries, layout
  readback, `ResizeObserver`, `IntersectionObserver`, and `requestAnimationFrame`
  ordering;
- full Web API surface snapshot comparison against Chromium;
- Web API behavior probes for constructors, descriptors, brand checks,
  receivers, collection liveness, event timing, URL behavior, fetch/XHR
  semantics, storage, focus/selection, and form defaults;
- e2e tests for no Service Worker registration;
- e2e tests that target scripts do not execute in native browser JS;
- Acid screenshot/score tests;
- Web API surface gap report tests.

## Removal Inventory

References expected to disappear by the end:

- `web/sw.js`;
- `web/sw-entry.mjs`;
- `web/sw/*`;
- `web/index.html` Service Worker bootstrap;
- `web/runtime/*` calls that route through `/zp/api/fetch`;
- `web/worker-prelude.js` `/zp/api/worker-script` routing;
- `/zp/sw.js`;
- `/zp/api/fetch`;
- `/zp/api/script`;
- `/zp/api/worker-script`;
- `navigator.serviceWorker.controller` assumptions in tests;
- target-JS whole-program Rust rewriter hot path.

References expected to remain:

- `cmd/wasm-kernel`;
- `wasm_exec.js`;
- `kernel.wasm`;
- `/zp/ws-pipe` or equivalent relay route;
- `__go_jshttp` during migration;
- `__zp_stream` during migration;
- `__zp_kernel_init` during migration;
- `__zp_cookie_set` during migration;
- `internal/zphttp`;
- `internal/socks5`;
- `internal/utlskernel`;
- `internal/wsproto`;
- `internal/cookiejar`;
- `internal/headers`;
- `internal/zpiso`;
- `rewriter-rs` only if still used for HTML/CSS/resource parsing.

## Risks

- QuickJS and Web API bridge scope is large even without transport rewrite.
- Running Go WASM in a Dedicated Worker may expose worker-specific API or timing
  differences.
- Foreground fallback can block the UI and must be treated as a compatibility
  path, not the preferred path.
- Moving Go kernel calls out of the Service Worker changes lifecycle,
  cancellation, streaming, and body ownership behavior.
- Raw-fetch mode must be carefully characterized so document transform behavior
  does not accidentally leak into the QuickJS path.
- IndexedDB-backed storage must preserve virtual-origin partitioning. A bug here
  can leak state across target origins or tabs.
- HTTP cache semantics are easy to get subtly wrong. `Vary`, credentials,
  redirects, revalidation, and no-store behavior need focused tests before
  enabling broad caching.
- Browser speculation and resource discovery can bypass QuickJS if target URLs
  reach native markup. Preconnect, preload, favicon, stylesheet, image, font,
  media, iframe, object, and manifest surfaces need sanitizer coverage before
  Service Worker deletion.
- Native renderer leaks remain the main escape risk.
- Event loop ordering will break frameworks if it is approximate.
- Service Worker removal invalidates many existing tests; they must be replaced
  with virtual-routing/backend tests, not deleted without coverage.

## Success Criteria

- The browser loads the ZeroProxy shell without registering a Service Worker.
- Go WASM network engine runs in a Dedicated Worker by default.
- The same Go WASM network engine runs in foreground fallback mode when Worker
  boot fails.
- No target request uses native browser `fetch` as a fallback.
- Native browser request logs contain no raw target-origin preconnect, preload,
  prefetch, favicon, image, stylesheet, font, media, script, iframe, object, or
  embed, form, manifest, or SVG resource requests.
- No target script executes in native browser JavaScript.
- QuickJS-NG executes target classic scripts, modules, and dynamic code.
- Virtual navigation handles hard, same-document, iframe, and popup paths.
- Target fetch/XHR/WebSocket/EventSource use `GoNetworkBackend`.
- Host browser resize propagates to virtual viewport, media queries, layout
  readback APIs, observers, and target `resize` listeners with browser-like
  ordering.
- GoNetworkBackend message protocol is versioned, stream-capable, backpressure
  aware, and identical across WorkerBackend and ForegroundBackend.
- `fetchRaw` is header-first, body-streamed, cancellable, and preserves final
  URL, headers, timing, cookie, redirect, and error metadata.
- IndexedDB is the durable backing store for virtual storage, HTTP cache, Cache
  API, and cache metadata, with virtual-origin partitioning and quota controls.
- HTTP cache and Cache API follow browser cache policy for cache modes,
  directives, revalidation, Vary, redirects, credentials, no-store, and
  eviction.
- Sanitizer emits schema records only; native renderer operations never carry
  raw target URLs.
- QuickJS host ABI uses opaque handles, deterministic ownership, event-loop
  scheduling, and renderer-safe mutation records.
- The Rust JS rewriter is not on the target-JS execution hot path.
- Full Web API surface comparator produces actionable missing/partial/blocked
  reports against Chromium.
- Implemented APIs have descriptor, brand-check, receiver, timing, and behavior
  probe coverage.
- New Acid-blocking or framework-blocking API gaps fail CI unless explicitly
  classified with an owner note.
- Acid tests pass by general bridge implementation, not fixture hacks.
