# ZeroProxy Implementation Status

Date: 2026-06-10

`PLAN.md` is the architecture contract. This file is the short repository-backed status ledger: what has landed, what is verified, and what still blocks PLAN completion.

## Current state

ZeroProxy has moved from the legacy Service Worker interception path toward the planned QuickJS/GoNetworkBackend virtual-browser path:

```text
Host shell
  -> QuickJS-NG WASM realm
  -> virtual DOM / Web API facades / host WebIDL bridge
  -> GoNetworkBackend
     -> Dedicated Worker Go WASM kernel, with foreground fallback
  -> existing WebSocket/smux/SOCKS5/uTLS transport
```

The migration is **not PLAN-complete**. The active path is in place and the legacy Service Worker/script-rewriter hot path is removed, but browser API parity is still partial.

## Snapshot metrics

Current checked-in `test/fixtures/webapi/webapi-gap-report.json`:

| Metric | Value |
|---|---:|
| Tracked Web API entries | 979 |
| Implemented entries | 219 |
| Partial entries | 726 |
| Blocked by gap | 0 |
| Blocked by policy | 29 |
| Out of scope | 5 |
| Hidden missing entries | 0 |
| Host browser `globalThis` keys | 979 |
| Pristine QuickJS `globalThis` keys | 71 |
| Browser-only before install | 911 |
| Installed QuickJS virtual-browser keys | 1060 |
| Shared host-browser keys after install | 977 |
| Browser-only after install | 2 (`Temporal`, `WebAssembly`; out of scope) |
| Descriptor-shape audited entries | 930 |
| Remaining shape-mismatching entries | 256 |
| Implemented entries with shape mismatches | 0 |

Interpretation: surface presence is nearly complete, but browser behavior/prototype/descriptor parity is still a large remaining workstream.

## Landed work

- Legacy Service Worker path removed from active runtime:
  - no active `/zp/sw.js` registration;
  - deleted `web/sw.js`, `web/sw-entry.mjs`, and `web/sw/*`;
  - server/source tests assert legacy SW and `/zp/api/*` hot-path spellings fail closed.
- Rust target-JS rewriter removed from the active browser hot path:
  - browser build/server no longer package or serve `rust-rewriter`/`http-rewriter` assets;
  - Rust rewrite exports fail closed;
  - Rust helper crate remains only for non-hot-path helper/characterization surfaces.
- Go WASM bridge characterized with tests for cookie sync/set, relay parsing, safe error responses, and error-class/status mapping.
- GoNetworkBackend protocol landed with worker and foreground backends, versioned envelopes, fetch/WebSocket/cookie/cache/storage/health/shutdown/cancel/error records, and unsupported-feature failures.
- QuickJS-NG runtime landed:
  - `third_party/quickjs-ng` submodule;
  - `quickjs-runtime/bridge.c` host ABI;
  - `web/runtime/quickjs/engine.mjs` realm lifecycle, host functions, module/classic eval, job draining, and wrapper identity.
- Virtual event loop and virtual DOM landed:
  - deterministic tasks, timers, microtasks, promise jobs, console capture, navigation reset/preservation;
  - event dispatch/listener options/AbortSignal removal;
  - virtual viewport/layout geometry, media queries, observers, animation/timeline basics, performance facades, and native event forwarding.
- Resource and document loading landed:
  - `internal/htmlsanitize` Go HTML sanitizer;
  - CSS/resource URL rewrite;
  - `web/runtime/resources/loader.mjs` document/resource loading through `GoNetworkBackend` and QuickJS evaluation.
- Network API facades landed:
  - QuickJS `fetch`, `Request`, `Response`, `Headers`, XHR, EventSource, WebSocket;
  - body consumption, abort, cookies, timing metadata, multipart/FormData basics, and virtual HTTP cache.
- Web API core/storage landed:
  - Blob/File/FileReader/DataTransfer/FormData, URL/URLSearchParams host backing, history/location/navigator/storage helpers;
  - IndexedDB/cache/local/session storage manager substrate and quota checks;
  - host WebIDL bridge for membrane-safe browser algorithms/reflection.
- Surface audit tooling landed:
  - browser and QuickJS surface snapshots;
  - `bridge-surface.json` classification;
  - JSON/Markdown gap report;
  - behavior probes;
  - acid-lite compatibility harness.
- CI workflow updated for the current QuickJS build requirements:
  - checks out the `third_party/quickjs-ng` submodule recursively;
  - installs Emscripten before JS/Puppeteer tests and deployable builds;
  - caches Puppeteer's browser download through `PUPPETEER_CACHE_DIR`.

## Latest descriptor/parity cleanup

Recent Web API shape work reduced descriptor/prototype mismatches to **256** while keeping `implementedShapeMismatchEntries: 0`.

Newly clean or materially improved groups include:

- Window global accessors and all tracked Window `on*` event-handler descriptors.
- `Scheduler`/`scheduler`, `trustedTypes`/`TrustedTypePolicyFactory`, `structuredClone`, `postMessage`.
- `Crypto`, `DOMImplementation`, `DOMParser`, `XMLSerializer`, `Selection`, `XPathEvaluator`.
- Streams/controllers and compression stream descriptor shapes.
- CSS namespace/math/value helpers, `StylePropertyMapReadOnly`, CSSOM rule/sheet mutator arity.
- `ResizeObserver`, `IntersectionObserver`, their entry/size payloads, and `PerformanceObserver` hidden-state cleanup.
- Long-tail `PerformanceEntry` subclasses: paint/event/long-task/LoAF/script/element/LCP/layout-shift/task-attribution entries.
- Animation/timeline/effect descriptor shape moved toward browser prototypes while preserving virtual `Element.animate()` and `getAnimations()` behavior.
- `MediaSource.setLiveSeekableRange()` now records/clears live seekable state instead of being a no-op; full media-element seekable integration remains partial.

- `Navigator`/`navigator`/`clientInformation`, `History`/`history`, and `IDBFactory`/`indexedDB` now use browser-shaped singleton/prototype descriptor placement while preserving virtual state.

- `Node` and `EventTarget` are descriptor-clean; virtual DOM internals keep child-node methods, event-handler state, and `parentNode`/`ownerDocument` behavior off the browser-shaped base prototypes.

- `Range` is descriptor-clean via browser arity/prototype placement while preserving existing boundary/text behavior.

- `MutationRecord` childList payload now records `previousSibling`/`nextSibling` for insert/remove, with behavior coverage.

- `Document` and `Element` descriptor deltas were reduced to their remaining prototype own-key gaps; parse/write/fullscreen/view-transition and element reflection/scroll/markup method arity/writability now match the browser snapshot.

- Blob URLs now dereference through virtual `fetch()` before revocation, covered alongside FileReader/FormData multipart behavior.

- Form validation now covers numeric `stepMismatch` in addition to required/type/range/custom validity, with reportValidity/checkValidity behavior coverage.

- XML/namespace handling now preserves qualified element/attribute names, prefixes, namespace-local lookup, and XMLSerializer namespaced tag casing.

- SVG element constructors use real prototype chains for created SVG elements; SVG value/list/animated value, text/positioning/animation/gradient bases, broad SVG filter/geometry primitives, SVGElement base reflection, link/image/marker/root/view/script/style facades, and most SVG element-specific descriptors now expose browser-shaped accessors, mutators, constants, and iterators while preserving `instanceof` behavior.

- `DocumentType` is descriptor-clean: `name`/`publicId`/`systemId`, child-node mutation methods, and `Symbol.unscopables` now live on the prototype with browser-shaped descriptors.
- `getComputedStyle()` now applies stylesheet/adopted-stylesheet author rules before inline styles for simple selector cascade coverage.

- Cache API now supports `Cache.add()`/`addAll()` through virtual `fetch()`, including blob URL responses persisted via the storage manager.

- Cookie writes now honor `Max-Age=0` / past `Expires` deletion in the virtual network cookie jar.

- IndexedDB object stores, indexes, cursors, records, databases, requests, open requests, and transactions now expose count/key lookup/list, record listing, key-cursor, cursor movement, update, delete, commit, and browser-shaped readonly/event-handler prototype accessors while retaining existing cursor/value/event behavior.

- MessagePort, MessageChannel, BroadcastChannel, and CustomElementRegistry now cover the current browser prototype own-key gaps without changing existing virtual message delivery or custom-element definition behavior.

- `CustomStateSet` now exposes browser-shaped set-like own prototype methods/iterator for `ElementInternals.states` while preserving Set-backed behavior.

- `ElementInternals` now exposes browser-shaped ARIA reflection accessors, `states`, and form/validity method lengths while preserving existing custom-element form behavior.

- `TaskController`, `TaskSignal`, `TaskPriorityChangeEvent`, `Scheduling`, WebGL object facades, SharedStorage method facades, and the `Audio` constructor now match browser task/scheduling and selected prototype-chain shapes while preserving QuickJS globals.

- Browser method arity was aligned for CropTarget/RestrictionTarget, DelegatedInkTrailPresenter, BYOB request, capture-track crop/restrict, AudioData, SourceBuffer, BaseAudioContext/AudioContext, EditContext, Sanitizer, Highlight, ImageBitmapRenderingContext, and Path2D surfaces without changing existing stubbed behavior.

- MediaStream, MediaStreamTrack, and MediaRecorder event-handler descriptors now use browser-shaped prototype accessors while preserving dispatch/event behavior.
- `CharacterData.prototype` now carries browser-shaped data/length/sibling/child-node mutation and substring helpers; constructor static shape remains intentionally unresolved because existing `instanceof` coverage still depends on the current virtual text/comment hierarchy.
- `HTMLFormControlsCollection` and `HTMLOptionsCollection` now expose browser-named iterator methods while preserving existing form/select collection behavior.

## Current blockers before PLAN completion

Remaining work is tracked by `test/fixtures/webapi/webapi-gap-report.json`; broad blockers are:
- DOM core parity: `Document`, `Element`, and remaining prototype-chain/property placement.
- HTML/SVG element long-tail descriptors and per-element behavior (`HTMLInputElement`, forms, anchors, media elements, scripts, remaining SVG edge behavior, etc.); most SVG value/filter/geometry/element-specific shape is covered.
- Parser/tree-construction, MutationRecord batching/subtree, and geometry edge semantics; XML namespace qualified-name basics are covered.
- Form validation/submission algorithms beyond covered basics; numeric step validation is covered.
- CSS cascade/layout/computed-style parity beyond simple stylesheet/adopted stylesheet rules and inline override coverage.
- Network edge behavior: redirect/credential/cache semantics, WebSocket failure/backpressure, true streaming request/response bodies.
- Multipart and Blob/File/FormData basics are covered; remaining edge work is deeper browser error-message/streaming parity.
- IndexedDB transaction lifecycle and history/storage edge cases still need deeper coverage; cursor movement/mutation, object store/index count/key lookup basics, Cache `put`/`add` persistence, and cookie deletion are covered.
- Detailed navigator/device/media policy behavior.
- Site-level parity for complex targets such as Google, Google Maps, Cloudflare, and Naver still needs repeated crawl/error collection against the current runtime.

## Latest verification

Latest commands run against the current working tree:

- `npm run build:web`: passed; regenerated web artifacts and `web/runtime/webapi/core-source.generated.mjs`.
- `node scripts/snapshot-quickjs-surface.mjs && node scripts/compare-webapi-surface.mjs && node scripts/probe-webapi-behavior.mjs`: passed; regenerated current Web API reports with `shapeMismatchEntries: 256` and `implementedShapeMismatchEntries: 0`.
- `npm run test:webapi-behavior`: passed 61/61, including `test/js/virtual-dom.test.js`.
- `npm run test:webapi-surface`: passed 3/3.
- `node scripts/compat-corpus.mjs --sites naver-desktop,naver-mobile,cloudflare,google-search,google-maps --out test/fixtures/representative-sites/latest-selected.json --timeout-ms 45000`: passed selected 5-site corpus; Naver desktop/mobile, Cloudflare, Google Search, and Google Maps all compared with no triage sites.

Not rerun after the latest changes:

- `npm run lint:js`;
- full `npm test`;
- `npm run test:e2e`;
- `npm run test:wasm`;
- full Go package matrix;
- `cargo test --manifest-path rewriter-rs/Cargo.toml`.

## Commit ledger

- `1d8fb9f feat: advance QuickJS virtual browsing migration` — committed the large QuickJS/GoNetworkBackend/WebAPI migration slice through the first WebAPI descriptor cleanup pass.
- Current uncommitted continuation after that commit: trustedTypes descriptor alignment, non-constructable callable descriptor cleanup, animation/timeline/effect descriptor cleanup, refreshed WebAPI fixtures, and this condensed status ledger.
