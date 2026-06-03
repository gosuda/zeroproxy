# Masking Surfaces

ZeroProxy keeps two URL and browser identities at the same time:

- the browser/proxy identity, used by the real browser, Service Worker, and
  `/zp/...` control routes;
- the target identity, exposed back to page JavaScript as if the page had loaded
  directly from the target origin.

This document lists the current masking surfaces in the page runtime, worker
runtime, and static rewriter. It is a maintenance reference for places where a
proxy URL, ZeroProxy helper, or browser fingerprint signal can otherwise leak
into target-visible JavaScript.

## Global Artifacts

| Surface | Masked behavior | Backing details |
|---|---|---|
| `Function.prototype.toString` | Patched ZeroProxy functions and accessors stringify like native browser functions. | `web/runtime/abi/artifact-masking.mjs`, `web/runtime-prelude.mjs`, `web/worker-prelude.js` maintain WeakMap-backed source strings. |
| Global object enumeration | ZeroProxy globals are hidden from `Object.keys`, `Object.getOwnPropertyNames`, `Object.getOwnPropertySymbols`, `Object.getOwnPropertyDescriptor(s)`, and `Reflect.ownKeys`. | Hidden names include `ZP`, `ZPRewriter`, `ZPRustRewriter`, `ZPHTTPRewriter`, `__ZP_*`, `__zp_*`, and ZeroProxy-marked symbols. |
| Runtime DOM artifacts | Runtime asset scripts and ZeroProxy-only attributes are filtered from DOM enumeration and serialization. | `data-zp-*` attributes are hidden from `getAttribute*`, `hasAttribute`, `getAttributeNames`, and `NamedNodeMap`-style access. |
| Selector probes | Selectors that explicitly target ZeroProxy internals return no match. | Examples include `data-zp-*`, `#__zp-boot`, `/zp/assets/`, `/zp/api/`, `src*=zp`, `zeroproxy`, and `x-zeroproxy-icon`. |

## Document, Location, and History

| Surface | Masked behavior | Backing details |
|---|---|---|
| `window.location` and `location` methods | `href`, `origin`, `protocol`, `host`, `hostname`, `port`, `pathname`, `search`, `hash`, `assign`, `replace`, `reload`, `toString`, `valueOf`, and `Symbol.toPrimitive` expose the virtual target URL. | Browser navigation still commits to encrypted share routes such as `/zp/p/<route>#k=...`. |
| `document.URL`, `document.documentURI`, `document.baseURI`, `document.referrer` | Return target-visible document, base, and referrer values. | `baseURI` tracks target `<base href>` state without exposing the proxy route. |
| `window.origin` | Returns the virtual target origin. | Defined from the visible document URL. |
| `history.pushState` and `history.replaceState` | Same-origin checks and stored visible URLs use the virtual target origin. | The real browser history URL is refreshed to a share route. |
| `hashchange` events | `oldURL` and `newURL` are target-visible URLs. | The proxy URL is not exposed through the event object. |
| Child frame `location` | Contained frame scopes expose target-visible `Location` facades. | Cross-window access is mediated by child and boundary window proxies. |

## URL Attributes and HTML Serialization

| Surface | Masked behavior | Backing details |
|---|---|---|
| Navigation attributes | `a[href]`, `area[href]`, `form[action]`, `button[formaction]`, and `input[formaction]` read back as target URLs. | The raw browser attribute can be a share route or rewritten control URL. Dynamic relative anchor `href`s are asynchronously rewritten to share URLs while page getters keep returning the target URL. |
| Resource attributes | `src`, `poster`, SVG `href`/`xlink:href`, stylesheet `href`, and related resource URLs read back as target URLs. | The real fetch path is commonly `/zp/api/fetch?...` or another ZeroProxy API route. |
| `srcset` | Page reads see the target `srcset` list. | Rewritten fetch URLs are stored separately from the visible list. |
| Script URLs | `script[src]` reads as the target script URL. | Executable scripts load through `/zp/api/script?...`; dynamic import and import maps are rewritten similarly. |
| Script `nonce` | Page reads preserve the target-visible nonce. | Executed scripts are assigned the runtime nonce `zp`; the original value is backed by `data-zp-target-nonce`. |
| Subresource `integrity` | Page reads preserve the target-visible integrity value. | The browser-visible `integrity` attribute is removed and backed by `data-zp-integrity` so rewritten bytes are not blocked by the original hash. |
| Link relations | Stylesheet links expose target `href`s; icon links are suppressed to an internal data URL; preload, prefetch, preconnect, and similar speculative links are blocked or removed. | Original blocked relation and URL state is backed by hidden `data-zp-*` attributes. |
| Navigation `target` | New-window targets are forced to safe same-context navigation. | Original targets are backed by `data-zp-blocked-target` and hidden from page reads. |
| `base[href]` | Updates the virtual base URL without exposing the proxy backing route. | Serialization omits the ZeroProxy backing state. |
| Meta policies | CSP and referrer policy tags are suppressed or virtualized when they would conflict with the membrane. | Blocked policy state is stored in hidden attributes. |
| `innerHTML` and `outerHTML` getters | Serialized HTML removes ZeroProxy helper nodes and `data-zp-*` attributes and restores target-visible URLs, `srcset`, script state, nonce, and integrity. | Script text that contains ZeroProxy internals is not exposed through serialization. |
| HTML insertion APIs | `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `DOMParser`, templates, `document.write`, and `srcdoc` content are rewritten before execution. | Inserted markup receives the same URL, script, style, and policy treatment as static HTML. |

## Network APIs

| Surface | Masked behavior | Backing details |
|---|---|---|
| `fetch`, `Request`, `Response`, and `Headers` | Page code uses target URLs and normal fetch-shaped objects. | Requests route through ZeroProxy APIs and the Service Worker; upload streams are relayed through runtime-controlled channels. |
| `XMLHttpRequest` | `responseURL`, request URL handling, events, upload object, and response fields are facade-backed. | Internal state slots are hidden on the XHR instance. |
| `sendBeacon` | Beacon targets resolve against the virtual target URL. | Native beacon transport is replaced by the ZeroProxy fetch path. |
| `WebSocket` and `WebSocketStream` | Constructors accept target `ws:`/`wss:` URLs. | Connections are opened through the ZeroProxy worker/kernel relay. |
| `EventSource` | Event streams resolve against target URLs and route through the membrane. | Backing transport is proxied. |
| Blocked network APIs | `RTCPeerConnection`, `WebTransport`, and unsupported direct network surfaces are blocked. | These fail closed with browser-shaped errors. |

## Performance and Fingerprinting

| Surface | Masked behavior | Backing details |
|---|---|---|
| `navigator.userAgent`, `appVersion`, `platform` | A fixed target persona is exposed. | Current runtime persona is Windows/Chrome-shaped in page and worker scopes. |
| `navigator.userAgentData` | Brands, full versions, architecture, bitness, platform, platform version, model, mobile, and WoW64 fields are fixed. | `getHighEntropyValues` and `toJSON` are native-masked. |
| Canvas readback | `CanvasRenderingContext2D.getImageData` and `HTMLCanvasElement.toDataURL` add small noise. | Used to reduce stable canvas fingerprint signals. |
| Audio readback | `AudioBuffer.getChannelData` adds tiny noise to the first non-zero sample. | Used to reduce stable audio fingerprint signals. |
| `performance.getEntries*` | Entry names expose target URLs, not `/zp/api/...` or asset URLs. | `rust-rewriter.wasm` and ZeroProxy assets are hidden; script timings can be synthesized for rewritten scripts. |
| `PerformanceObserver` | Observer entry lists are wrapped so resource and navigation names are target-visible. | `takeRecords` and list query methods apply the same masking. |

## Cookies and Storage

| Surface | Masked behavior | Backing details |
|---|---|---|
| `document.cookie` | Reads and writes operate on target-origin cookie records. | Cookie records are synced with the Service Worker and filtered by domain, path, secure, SameSite, and expiry rules. |
| `localStorage` and `sessionStorage` | Storage is scoped to `zp:<target-origin>:local` and `zp:<target-origin>:session`, while page code sees ordinary Storage objects. | Native localStorage and IndexedDB are used as backing stores. |
| `storage` events | Event `url` is the virtual target URL. | Events are dispatched between runtime-managed same-origin windows. |
| `indexedDB` | Database names are target-visible. | Native database names are prefixed with `zp:<target-origin>:idb:` and stripped in `indexedDB.databases()`. |
| `caches` | Cache names are target-visible. | Native cache names are prefixed with `zp:<target-origin>:cache:` and stripped in `caches.keys()`. |

## Frames, Messaging, and Workers

| Surface | Masked behavior | Backing details |
|---|---|---|
| Child frame globals | `window`, `self`, `globalThis`, and `frames` resolve to a scoped facade; `top`, `parent`, and `opener` resolve to boundary facades. | Raw frame windows are wrapped to keep target/proxy identity separated. |
| `postMessage` target origin | Target origins are accepted and mapped to the proxy origin when needed. | Message dispatch still uses the browser-required proxy origin underneath. |
| `MessageEvent.origin` and `MessageEvent.source` | Event origin and source are virtualized back to target-visible values. | Source windows are wrapped with the appropriate facade. |
| Worker `location` and `origin` | Dedicated and shared workers see target-visible worker URLs and origins. | Worker scripts load through `/zp/api/worker-script?...` and `worker-prelude.js`. |
| Worker global enumeration | Worker `location`, `fetch`, `importScripts`, and ZeroProxy internals are hidden from global enumeration. | Worker `Object.*` and `Reflect.ownKeys` are patched similarly to page globals. |
| Worker network APIs | `fetch` and `importScripts` accept target URLs; direct network APIs are blocked where unsupported by the membrane. | Worker fetches and scripts route through ZeroProxy APIs. |
| Worker object URLs | Worker `URL.createObjectURL` and `revokeObjectURL` are wrapped for script blobs. | Page-visible blob worker URLs can differ from the internal wrapper blob. |

## Known Limits

- Browser-devtools protocol, native browser internals, and network logs can still
  observe browser/proxy backing URLs. Masking is for target page JavaScript, not
  for the local operator's debugging tools.
- Exact CSS selector semantics for rewritten target URL attributes are not fully
  virtualized. Page getters return target URLs, and explicit ZeroProxy probes are
  blocked, but selectors that compare raw rewritten attribute values can still be
  limited by the browser's underlying DOM matcher.
- The static Rust rewriter and dynamic JavaScript runtime must stay aligned:
  static markup, dynamically assigned attributes, inserted HTML, workers, and
  frame `srcdoc` all need the same target-visible contract.
