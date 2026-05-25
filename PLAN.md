# ZeroProxy Zero-Installation Proxy Browsing Engine Design

## 0. Source Specification and Correction Directives

This document is based on the user-provided `ZeroProxy Client Kernel Implementation Spec v0.8` plus the May 2026 final correction directive. The correction directive overrides earlier text where there is a conflict.

Resolved architecture invariants:

- Target pages run as top-level documents. ZeroProxy must not use a top-level iframe for target rendering. The virtual address bar/topbar is injected directly into the transformed target HTML stream.
- Shared URLs keep the v0.8 entry format `/p/<encrypted>#k=<key>`.
- Active browsing routes are unified under `/v`:
  - Fixed active history entry: `/v/<tab-id>/e/<entry-id>`
  - New navigation request: `/v/<tab-id>/n/<base64url_target_url>`
- Shared URL encryption is fixed to an AES-256-CBC + HMAC-SHA256 envelope. CBC without authentication is forbidden.
- Phase 0 relaxes resource-loading CSP directives for compatibility, but `connect-src 'self' wss://proxy.example` and `form-action 'self'` remain strict. CSP relaxation is not a network permission bypass; the Service Worker classifier remains the egress enforcement point.
- Anti-bot stealth, CAPTCHA bypass, `Function.prototype.toString` native spoofing, and global `Object.getOwnPropertyDescriptor` deception are not goals and must not be implemented.
- Target egress must not use browser-native `fetch`, native `WebSocket`, `net.Dial`, or Go `http.Transport`'s default dial path.
- Existing similar Go/JS code is usable only as an example of `Request`/`Response` conversion, streaming bridges, and Service Worker ↔ Go WASM handler registration patterns. Any direct `fetch(e.request)` fallback or cross-origin native WebSocket fallback from that code must be removed from this design.

Use the Go HTML package `golang.org/x/net/html`. If a request document mentions `x/net/text/html`, treat that as a package-name typo and correct it to `x/net/html`.

## 1. System Goals

ZeroProxy is a client-held virtual browsing engine composed of a static client, Service Worker, Go WASM transport kernel, Tor SOCKS5 stream isolation, uTLS, and runtime polyfills.

Highest-priority security invariants:

1. Target sites never receive a direct connection from the user's real IP.
2. All target HTTP/TLS/WebSocket traffic exits only through `Service Worker → Go WASM → single WebSocket binary pipe with yamux streams → Tor SOCKS5 DOMAINNAME CONNECT per stream → uTLS → HTTP/1.1`.
3. The server stores no session, cookie, history, or target URL state.
4. Target URLs, cookie jars, storage namespaces, and history entries live only in client memory or client-side encrypted state.
5. Every request the Service Worker cannot classify is blocked with `Response.error()` or a safe error response.
6. The target realm must not be able to access the share key, state encryption key, HttpOnly cookies, or transport secrets.
7. WebRTC, WebTransport, WebSocketStream, and native device APIs must not call real networks or devices.

Non-goals:

- Guaranteed anti-bot stealth
- CAPTCHA risk-score manipulation
- Perfect browser-native origin impersonation
- Full target Service Worker emulation
- Exact JS descriptor or native function string parity

## 2. Overall Architecture

```text
Browser tab
  ├─ Static shell /
  ├─ Service Worker /sw.js
  │   ├─ route classifier
  │   ├─ share-link decrypt gate
  │   ├─ virtual tab state registry
  │   ├─ response constructor policy
  │   └─ Go WASM kernel (__go_jshttp, __zp_stream)
  │       ├─ wsconn: single WebSocket binary net.Conn adapter
  │       ├─ yamux: multiplexed target streams over the wsconn session
  │       ├─ socks5: DOMAINNAME CONNECT + SOCKS auth isolation
  │       ├─ utls: target TLS client in WASM
  │       ├─ zphttp: target HTTP/2 and HTTP/1.1 engine
  │       ├─ htmltx: x/net/html stream transform
  │       │   ├─ runtime prelude injection
  │       │   ├─ topbar injection
  │       │   └─ static navigation laundering
  │       ├─ cookiejar: target cookie isolation
  │       └─ parser: HTTP response parser / redirect engine
  ├─ Runtime prelude injected before target scripts
  │   ├─ fetch / XHR / WebSocket / EventSource / sendBeacon wrappers
  │   ├─ history / location facade and navigation traps
  │   ├─ document.cookie facade
  │   ├─ navigation and form capture
  │   ├─ worker / iframe / blob hooks
  │   └─ privacy profile shims
  └─ Target document as top-level document

Proxy origin server
  ├─ serves /, /sw.js, /__zp/*, wasm assets
  └─ /__zp/ws-pipe WebSocket endpoint
       └─ yamux server session
            └─ per-stream byte bridge to Tor daemon SOCKS5 port with IsolateSOCKSAuth
                 └─ Tor circuit → target host
```

The server-side WebSocket endpoint terminates only the WebSocket and yamux session needed to multiplex streams between the browser Service Worker and the SOCKS5 bridge. Each accepted yamux stream is byte-bridged to the Tor SOCKS5 daemon; the server does not parse HTTP, terminate target TLS, or store per-target state. Target TLS connections and HTTP parsing run inside the Go WASM kernel. Relay logging is forbidden by server operating policy. Technically, SOCKS5 CONNECT domains and TLS SNI are observable at the relay/Tor boundary, so “server statelessness” in this design means the server does not store target URL state or browsing state.

## 3. URL and Encryption Specification

### 3.1 Shared URL

```text
https://proxy.example/p/<encrypted>#k=<key>
```

- `<encrypted>`: base64url encoding of `iv || ciphertext || tag`
- `#k=<key>`: fragment containing a base64url-encoded 64-byte random seed
- Plaintext: only the UTF-8 bytes of the canonical target URL. Do not include metadata.

### 3.2 Key Derivation

```text
seed    = base64url_decode(k)                 // 64 bytes
enc_key = HKDF-SHA256(seed, salt="", info="zp-url-cbc-enc", length=32)
mac_key = HKDF-SHA256(seed, salt="", info="zp-url-cbc-mac", length=32)
```

### 3.3 Blob Layout

```text
struct ShareBlob {
  uint8[16] iv;
  uint8[]   ciphertext; // AES-256-CBC with PKCS#7 padding
  uint8[32] tag;        // HMAC-SHA256
}

tag = HMAC-SHA256(mac_key, "ZP-CBC-URL-V1" || iv || ciphertext)
```

Minimum length: `16 + 16 + 32` bytes.

### 3.4 Decryption Procedure

1. Extract `/p/<encrypted>` from `location.pathname`.
2. Extract `k` from `location.hash`.
3. Base64url-decode `<encrypted>`.
4. Validate length.
5. Split `iv`, `ciphertext`, and `tag`.
6. Derive `enc_key` and `mac_key` from `seed` with HKDF.
7. Verify HMAC before AES-CBC decryption.
8. On HMAC mismatch, immediately stop with `SAFE_ERROR(BAD_HMAC)`.
9. Perform AES-CBC decryption and PKCS#7 padding removal.
10. UTF-8-decode the plaintext.
11. Parse the canonical URL.
12. Allow only `http:` and `https:` protocols.
13. Store the target URL in virtual tab state.
14. Remove the fragment key from the address bar with `history.replaceState`.
15. Switch to `/v/<tab-id>/e/<entry-id>` and start virtual navigation.

Remove `#k` immediately after decryption. A cold restore without state must re-enter through `/p/<encrypted>#k=<key>`.

## 4. Active URL, Navigation URL, and Tab State

During active browsing, the address bar never contains the target URL directly.

```text
/v/<tab-id>/e/<entry-id>
```

New document navigation requests use a transient route.

```text
/v/<tab-id>/n/<base64url_target_url>
```

Route rules:

- `tab-id`: random 96-bit, base32/base64url-safe string
- `entry-id`: virtual history entry id, for example `e00012`
- `base64url_target_url`: raw base64url without padding of the UTF-8 absolute canonical target URL
- `/v/<tab-id>/n/<base64url_target_url>` is not a stable address-bar state. The Service Worker allocates an entry, stores the navigation state, and redirects to `/v/<tab-id>/e/<entry-id>`.
- For form submissions, the `/n` request body, method, referrer policy, and relevant headers are captured into a pending navigation record before the redirect. The `/e` handler consumes that pending request exactly once when fetching the target document.

```ts
type TabState = {
  tabId: string;
  activeEntryId: string;
  entries: Map<string, HistoryEntry>;
  originMap: Map<string, VirtualOrigin>;
  cookieJar: CookieJar;
  storageNamespaces: StorageNamespaceMap;
  runtimeProfile: RuntimeProfile;
  streamIsolationKey: CryptoKey | Uint8Array;
};

type HistoryEntry = {
  entryId: string;
  targetUrl: string;
  title: string;
  stateClone: unknown;
  scrollX: number;
  scrollY: number;
  createdAt: number;
  pendingNavigation?: PendingNavigation;
};

type PendingNavigation = {
  method: string;
  headers: [string, string][];
  body?: Uint8Array;
  referrer?: string;
  consumed: boolean;
};
```

State storage policy:

- Memory state is the authoritative source.
- IndexedDB persistence is optional, but persisted state must be client-side encrypted.
- Plaintext tab state, cookie encryption keys, share seeds, and transport secrets must not be stored in target-visible storage.
- Target-visible `localStorage`, `sessionStorage`, IndexedDB, and CacheStorage are namespace-isolated through runtime facades.
- If Service Worker restart loses memory state, fail safely with `/__zp/error/SW_NOT_READY` or `/__zp/error/INVALID_SHARE_LINK`.

## 5. Service Worker Boot Sequence

The initial shell must obtain a Service Worker controller before target browsing starts.

1. Visit `/`.
2. Register `/sw.js`.
3. Install.
4. Activate.
5. Run `clients.claim()`.
6. Observe `controllerchange`.
7. Perform a controlled reload.
8. Load the Go WASM kernel and run readiness checks.
9. Handle the `/p` or `/v` route.

Readiness stages:

```text
UNINITIALIZED → WASM_LOADING → WASM_LOADED → READY
```

`READY` requires:

- `__go_jshttp(request): Promise<Response>` registered
- Runtime message bridge registered
- Transport kernel initialized
- Internal asset fetch path separated from target egress path

## 6. Service Worker Fetch Handler Policy

Every fetch event must be classified into exactly one of the following categories. The handler must call `event.respondWith` for every controlled request; fallthrough to the browser network is forbidden.

| Class | Handling |
|---|---|
| `INTERNAL_ASSET` | Return `/__zp/*`, wasm, runtime, shell, or internal error assets. Native fetch/cache is allowed only for explicitly allowlisted same-origin static assets. |
| `SHARE_LINK` | Return shell for `/p/<encrypted>`. Decrypt the hash key in the window context. |
| `VIRTUAL_NAVIGATION` | Decode `/v/<tab>/n/<base64url_target_url>`, validate the target URL, allocate an entry, persist pending request data if needed, and redirect to `/v/<tab>/e/<entry>`. |
| `VIRTUAL_ENTRY` | Restore target URL and pending navigation from `/v/<tab>/e/<entry>` → transport fetch → HTML transform → return `Response`. |
| `VIRTUAL_SUBRESOURCE` | Restore virtual base from `clientId`, `Referer`, and initiator metadata → canonicalize target URL → transport fetch. |
| `RUNTIME_API` | Handle runtime ↔ Service Worker bridge endpoints. |
| `UNKNOWN` | Return `Response.error()` or a safe error response. |

Absolutely forbidden:

```js
return fetch(event.request)
```

Exception: only explicitly allowlisted same-origin proxy-internal static assets such as `/__zp/*`, `/sw.js`, wasm, manifest, and internal error pages may use native fetch/cache. Do not use native fetch for target-origin URLs or unclassified requests.

Navigation route requirements:

- Decode path payload with raw base64url semantics. Do not accept standard base64 characters that can split path segments.
- Generate entry ids with `crypto.getRandomValues`; never use `Math.random`.
- Validate protocol allowlist before storing the entry.
- Preserve POST/form navigation data through `PendingNavigation` rather than relying on redirect semantics to carry the body.
- On decode or validation failure, return `/__zp/error/MALFORMED_ROUTE` as an internal safe error page.

Non-origin request handling:

- A Service Worker fetch event may receive cross-origin subresource requests from a controlled client.
- If `url.origin !== self.location.origin`, do not pass it through immediately.
- If a virtual base can be restored, handle it as `VIRTUAL_SUBRESOURCE`.
- Otherwise classify it as `UNKNOWN` and block it.

## 7. Go WASM Transport Kernel

### 7.1 Transport Path

```text
Service Worker
  → Go WASM stream adapter
  → single WebSocket binary pipe to proxy origin
  → yamux stream per target connection
  → Tor SOCKS5 CONNECT with DOMAINNAME ATYP
  → uTLS handshake in WASM
  → HTTP/1.1 request/response parser
  → response constructor policy
  → browser Response
```

Constraints:

- Do not use browser-native fetch for target egress.
- Do not use Go `net.Dial`.
- Do not use the default network path of Go `http.Client`/`http.Transport` for targets.
- Maintain one long-lived WebSocket `net.Conn` per Service Worker/kernel session and run yamux over it.
- Represent each target TCP connection as a yamux stream; run SOCKS5 CONNECT inside that stream.
- SOCKS5 CONNECT must use DOMAINNAME ATYP, not IPv4/IPv6 ATYP.
- The browser must not resolve target hostnames.
- uTLS handshake runs inside WASM.
- Phase 0 ALPN advertises only `http/1.1`.
- HTTP/2, HTTP/3, and QUIC are excluded from Phase 0.

The kernel opens `wsconn.Dial` once during transport initialization, wraps it with a yamux client session, and reuses that session until the Service Worker is restarted or the relay fails. Concurrent fetch, XHR, WebSocket, and EventSource transports open independent yamux streams. Closing or aborting one browser request closes only its yamux stream, not the shared WebSocket session.

### 7.2 Go Module Layout

```text
cmd/wasm-kernel/
  main.go                    // __go_jshttp, __zp_stream handler export
internal/swhttp/
  bridge.go                  // JS Request ↔ http.Request, http.Response ↔ JS Response
  response_writer.go         // streaming ResponseWriter
internal/wsconn/
  conn.go                    // single WebSocket binary net.Conn
  relay.go                   // open/close/backpressure/abort
internal/yamuxconn/
  session.go                 // yamux client session over wsconn
  stream.go                  // per-target net.Conn streams
internal/socks5/
  client.go                  // SOCKS5 handshake, auth, DOMAINNAME CONNECT over yamux stream
internal/zpiso/
  token.go                   // stream isolation token derivation
internal/utlskernel/
  dial.go                    // uTLS UClient over yamux+socks5
internal/zphttp/
  roundtrip.go               // net/http Request + net/textproto response parse
  redirect.go                // internal redirect engine
internal/htmltx/
  transform.go               // x/net/html tokenizer stream transform
  topbar.go                  // virtual topbar injection
  srcdoc.go                  // srcdoc prelude injection
internal/headers/
  policy.go                  // response header constructor policy
internal/cookiejar/
  jar.go                     // Set-Cookie parse, document.cookie projection
internal/runtimeapi/
  api.go                     // runtime bridge endpoints
```

### 7.3 HTTP/1.1 Engine

Use `net/http` for Request/Response/Header types and the server-style handler model. Do not use `http.Transport` for target egress. Instead, implement direct HTTP/1.1 round trips equivalent to `net/textproto`, `bufio`, `http.ReadResponse`, and `Request.Write`.

```go
func (k *Kernel) RoundTrip(ctx context.Context, req *http.Request, target *url.URL, tab *TabState) (*http.Response, error) {
    host := canonicalHost(target)
    port := canonicalPort(target)

    token := zpiso.Token(tab.StreamIsolationKey, host)

    stream, err := k.Mux.OpenStream(ctx)
    if err != nil { return nil, err }

    if err := socks5.ConnectDomain(ctx, stream, socks5.Options{
        Host: host,
        Port: port,
        Username: token,
        Password: "zp",
    }); err != nil { stream.Close(); return nil, err }

    var rw io.ReadWriteCloser = stream
    if target.Scheme == "https" {
        tlsConn := utls.UClient(stream, &utls.Config{
            ServerName: host,
            NextProtos: []string{"http/1.1"},
        }, utls.HelloChrome_Auto)
        if err := tlsConn.HandshakeContext(ctx); err != nil { stream.Close(); return nil, err }
        rw = tlsConn
    }

    wireReq := buildHTTP1Request(req, target, tab.CookieJar)
    if err := writeHTTP1Request(rw, wireReq); err != nil { rw.Close(); return nil, err }

    br := bufio.NewReader(rw)
    resp, err := http.ReadResponse(br, wireReq)
    if err != nil { rw.Close(); return nil, err }
    resp.Body = bodyWithConnClose(resp.Body, rw)
    return resp, nil
}
```

When implemented, `buildHTTP1Request` removes hop-by-hop headers and constructs `Host`, `Origin`, `Referer`, and `Cookie` from the target URL. Raw `Location` must not be exposed through the browser `Response`; the redirect engine handles it internally.

### 7.4 uTLS Profile Selection

Use a fixed browser-like ClientHello profile, selected from Chrome or Firefox families according to deployment policy. ALPN remains pinned to `http/1.1` until the HTTP/2 implementation exists. Do not advertise `h2` without an HTTP/2 transport path.

TLS validation rules:

- Certificate verification: enabled
- Hostname verification: enabled
- SNI: target hostname
- Session ticket: selected uTLS profile default
- GREASE: selected uTLS profile default

Expired, invalid, or hostname-mismatched certificates must map to a ZeroProxy safe error page. Do not pass raw TLS library errors or target stack details to the target-visible document.

## 8. HTML Stream Transform and Topbar Injection

The HTML transform defaults to a streaming transform based on the `golang.org/x/net/html` tokenizer. Use full DOM parsing only for tests or recovery fallback.

Required transforms:

1. Inject ZeroProxy topbar HTML/CSS directly into the target document. Prefer immediately after `<body>` begins; if `<body>` is absent, synthesize a safe insertion point.
2. Inject `/__zp/runtime-prelude.js` before any target script.
3. Remove or neutralize `<base href>`.
4. Rewrite or remove `<meta http-equiv="refresh">`.
5. Force-launder static document navigation URLs:
   - `<a href>` → `/v/<tab-id>/n/<base64url_target_url>`
   - `<area href>` → `/v/<tab-id>/n/<base64url_target_url>`
   - `<form action>` → `/v/<tab-id>/n/<base64url_target_url>`
   - `input/button formaction` → `/v/<tab-id>/n/<base64url_target_url>`
6. Rewrite `<iframe src>` document navigation URLs to controlled URLs.
7. Inject the runtime prelude into `<iframe srcdoc>`.
8. Rewrite `<frame src>`.
9. Replace `<object data>` and `<embed src>` with blocked placeholders.
10. Remove `<a ping>`.
11. Remove or convert `modulepreload`, `preload`, `prefetch`, `preconnect`, `dns-prefetch`, `prerender`, `speculationrules`, and `manifest` to controlled URLs.

Static laundering rules:

- Resolve relative URLs against the current virtual target URL before encoding.
- Encode with raw base64url without padding.
- Do not rewrite `javascript:` or fragment-only links as navigations. Unsupported active schemes are blocked or neutralized.
- Native top-level cross-origin navigation must never be left in the output HTML.
- For forms, only the action URL is encoded into `/n`; method and body are preserved by the Service Worker pending navigation capture.

Fatal transform errors:

- If the tokenizer returns a non-EOF error, the upstream read fails, or the transformer detects unrecoverable structural state, stop target rendering and return a ZeroProxy safe error page.
- Parser-recoverable malformed markup should be transformed in recovery mode. Only fatal transform failure becomes `MALFORMED_HTML`.

## 9. Tor SOCKS5 Identity Stream Isolation

Tor daemon configuration:

```text
SocksPort 127.0.0.1:9050 IsolateSOCKSAuth
```

SOCKS5 rules:

- CONNECT must use only DOMAINNAME ATYP.
- Put the client-computed isolation token in Username.
- Use a fixed sentinel or an empty value for Password. The token belongs in username, not password.
- Compute the token at site/domain granularity without target path or query.

Recommended token derivation:

```text
normalized_host = lower(punycode(hostname))
isolation_site = eTLD+1(normalized_host) if available else normalized_host
token = base64url(HMAC-SHA256(streamIsolationKey, "zp-streamiso-v1\0" || isolation_site))[0:43]
```

Effects:

- Tor allocates a separate circuit when the SOCKS auth username differs.
- The server stores no circuit mapping state.
- The same site may reuse the same circuit inside the same tab/session, while different sites are isolated.

Notes:

- `streamIsolationKey` is generated client-side when the tab/session is created.
- The token does not include the full URL, cookies, or share key.
- Target hostname DNS resolution is delegated to Tor.

## 10. Response Header Constructor Policy

Do not create a separate “header rewrite” module. Apply constructor policy immediately before creating the browser `Response` from the transport response.

### 10.1 Headers Not Exposed

Do not expose these headers through the browser `Response`.

- `Set-Cookie`
- `Set-Cookie2`
- `Content-Security-Policy`
- `Content-Security-Policy-Report-Only`
- `Report-To`
- `Reporting-Endpoints`
- `NEL`
- `Service-Worker-Allowed`
- `SourceMap`
- `X-SourceMap`
- `Alt-Svc`
- `Link`
- `Refresh`
- `Clear-Site-Data`
- `Content-Length` when body transformed
- `Content-Encoding` when body decoded

### 10.2 Internally Handled Headers

- `Set-Cookie`: absorb into the cookie jar.
- `Location`: handle through the transport redirect engine. Do not expose raw `Location` to the browser.
- `Refresh`: absorb through HTML/meta refresh handling or remove it.
- `Content-Type`: use for MIME dispatch, then forward only safe values.
- `Cache-Control`: default target responses to `no-store`.

## 11. Phase 0 CSP

ZeroProxy does not forward target response CSP headers. The shell/runtime response constructor generates a fixed ZeroProxy policy.

Phase 0 compatibility policy:

```text
default-src 'none';
script-src * 'unsafe-inline' 'unsafe-eval' blob: data:;
style-src * 'unsafe-inline' blob: data:;
img-src * blob: data:;
font-src * blob: data:;
media-src * blob: data:;
connect-src 'self' wss://proxy.example;
frame-src 'self' blob: data:;
child-src 'self' blob: data:;
worker-src 'self' blob:;
object-src 'none';
base-uri 'none';
form-action 'self';
navigate-to 'self';
manifest-src 'self';
```

Compatibility relaxation applies to resource-loading directives so target images, stylesheets, fonts, media, and scripts can be requested in normal browser shapes. It does not permit direct target egress. Every such request is still intercepted by the Service Worker and either transported through ZeroProxy or blocked.

`connect-src` and `form-action` are strict because they directly affect network escape. Replace `wss://proxy.example` with the actual deployment origin.

## 12. Runtime Prelude

`runtime-prelude.js` must run before target scripts. Install it once per realm and remove its own `<script>` element immediately after execution.

Responsibilities:

- Capture native references inside an IIFE closure before target code runs.
- Install fetch/XHR/WebSocket/EventSource/sendBeacon wrappers.
- Install location/history facades and navigation traps.
- Install document.cookie facade.
- Capture navigation clicks and form submissions.
- Hook `HTMLFormElement.prototype.submit` and `requestSubmit` because direct `.submit()` does not dispatch a submit event.
- Install DOM setter hooks for URL-bearing attributes and properties.
- Install worker/worklet/blob URL hooks.
- Install iframe instrumentation hooks.
- Install privacy profile shims and WebRTC blocking stubs.
- Initialize about:blank iframes/popups before target code can use their clean realms.

Polyfill consistency:

- Wrapper globals must not be enumerable.
- Keep internal namespace state in Symbols or closures.
- ZeroProxy internal keys must not appear in `Object.keys(window)` or `for...in`.
- Do not create a structure where `JSON.stringify(window.__zp)` can expose internals. Prefer not to define `window.__zp` at all.
- Do not patch `Function.prototype.toString` globally and do not spoof native strings.
- Do not patch `Object.getOwnPropertyDescriptor` globally.
- Do not launder native functions through a clean iframe realm.
- Normalize wrapper errors to DOMException/TypeError categories without exposing internal stacks.

### 12.1 Navigation and Form Traps

Runtime URL wrapping:

```text
absolute_target_url = new URL(input, currentVirtualTargetUrl).href
wrapped_url = /v/<tab-id>/n/<raw_base64url(absolute_target_url)>
```

Required traps:

- Click navigation for `<a>` and `<area>`.
- Submit navigation for `<form>` submit events.
- Direct `HTMLFormElement.prototype.submit` calls.
- `HTMLFormElement.prototype.requestSubmit` calls.
- `form.action` and `input/button.formAction` property setters.
- `Location.assign()` and `Location.replace()`.
- `history.pushState()` and `history.replaceState()` virtual URL updates.
- DOM setters: `setAttribute`, `href`, `src`, `action`, `formAction`, `srcdoc`, `innerHTML`, and `insertAdjacentHTML` for URL-bearing elements.

Direct `location.href = ...` caveat: in modern browsers, top-level `window.location` is commonly unforgeable or non-configurable. The implementation must install a setter trap where descriptors permit it, but must not rely on replacing `window.location` as the only defense. Static laundering, click/form traps, `Location.assign`/`replace` hooks, strict `navigate-to 'self'`, and Service Worker route enforcement are all required layers.

### 12.2 Read Fidelity and Getter Masking

Target code should read virtual target URLs, not ZeroProxy routing URLs, from common DOM surfaces.

Mask these surfaces where descriptors are configurable or prototype-level hooks are available:

- `location.href`, `protocol`, `host`, `hostname`, `port`, `pathname`, `search`, `hash`, `origin`
- `document.URL`, `document.documentURI`, `document.baseURI`
- `HTMLAnchorElement.href`
- `HTMLAreaElement.href`
- `HTMLFormElement.action`
- `HTMLInputElement.formAction`
- `HTMLButtonElement.formAction`
- URL-bearing reflected attributes when read after ZeroProxy rewrites them

Descriptor policy:

- Lock installed descriptors with `configurable: false` where safe.
- Preserve browser invariants for non-configurable native descriptors; do not crash if a descriptor cannot be replaced.
- Never implement read fidelity by globally lying through `Object.getOwnPropertyDescriptor`.

### 12.3 Network API Wrappers

#### fetch

```ts
zpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
```

Procedure:

1. Normalize input.
2. If the input is a `Request`, extract URL, method, headers, and body.
3. Resolve URL against the current virtual base.
4. Canonicalize the target URL.
5. Store credentials/mode/referrer/redirect/cache/integrity metadata.
6. Send through the Service Worker message bridge or internal fetch endpoint.
7. Return the transport response as a `Response` facade.

The Service Worker fetch-event block policy defends against wrapper misses.

#### XMLHttpRequest

Implementation targets:

- `open`
- `setRequestHeader`
- `send`
- `abort`
- `getResponseHeader`
- `getAllResponseHeaders`
- `overrideMimeType`
- `responseType`
- `withCredentials`
- `timeout`
- Upload progress
- `readystatechange`, `load`, `error`, `abort`, `loadend`

`responseURL` returns the virtual final URL.

#### WebSocket

`new WebSocket(url, protocols)` must not use native WebSocket. Route both same-origin and cross-origin WebSockets through an internal WebSocket transport stream.

Procedure:

1. Resolve the target `ws:`/`wss:` URL.
2. Map `ws:` to HTTP and `wss:` to HTTPS target transport.
3. Perform target WebSocket HTTP Upgrade in the Go WASM transport.
4. Bridge frames.
5. Bridge close code/reason.

Remove any cross-origin native fallback from existing similar code.

#### EventSource / sendBeacon

- EventSource: `text/event-stream` parser over the transport stream
- sendBeacon: send the body to the transport kernel as a queued request and return `true` when queueing succeeds

### 12.4 WebRTC and Device API Blocking

Install blocking stubs in every reachable realm for:

- `RTCPeerConnection`
- `webkitRTCPeerConnection`
- `RTCDataChannel` construction paths
- WebTransport
- WebSocketStream
- Serial, HID, USB, Bluetooth, MIDI, and other native device APIs exposed by the browser

The stub must throw a normalized `DOMException` such as `NotSupportedError` and must not expose internal ZeroProxy stack traces.

## 13. Worker and Worklet Containment

Main-window IIFE hooks do not automatically control independent worker globals. The runtime must hook worker creation before target scripts run.

Required hooks:

- `Worker`
- `SharedWorker`
- `ServiceWorkerContainer.register` for target-origin registrations
- `Worklet.addModule` variants where exposed
- `URL.createObjectURL` for worker-bound Blob scripts
- `importScripts` inside worker scope

Worker boot strategy:

1. Resolve the requested worker script URL against the current virtual target URL.
2. Replace the requested script with a same-origin ZeroProxy worker bootstrap URL or Blob.
3. The bootstrap installs the worker runtime prelude first.
4. The bootstrap imports or streams the target worker script through ZeroProxy transport.
5. Worker-scope `fetch`, XHR, WebSocket, EventSource, WebRTC, WebTransport, and device APIs are wrapped or blocked before target worker code runs.

Direct worker construction from target URLs is forbidden. Blob workers are allowed only if ZeroProxy wraps their source and prepends the worker runtime prelude.

## 14. Dynamic Iframe and Clean-Realm Containment

Target scripts may try to create a clean iframe and call `iframe.contentWindow.fetch` or other native APIs before ZeroProxy patches that realm. This is a primary escape vector and must be blocked synchronously.

Required iframe defenses:

- Hook `document.createElement` for `iframe` and `frame`.
- Hook `appendChild`, `insertBefore`, `replaceChild`, `innerHTML`, and `insertAdjacentHTML` paths that insert iframes.
- Instrument about:blank iframes immediately after insertion and before returning control to target code.
- Patch `HTMLIFrameElement.src` and `srcdoc` setters.
- Rewrite iframe `src` to controlled ZeroProxy document routes.
- Transform `srcdoc` with runtime prelude injection before assignment.
- Use a `MutationObserver` only as a backup; it is not synchronous enough to be the primary defense.
- If an iframe realm cannot be instrumented, block or neutralize that iframe rather than allowing a clean native realm.

Child iframes created by target content are allowed only as controlled ZeroProxy documents. The top-level target page itself still remains a top-level document, not a UI iframe.

## 15. History / Location

Location facade targets:

- `href`
- `protocol`
- `host`
- `hostname`
- `port`
- `pathname`
- `search`
- `hash`
- `origin`
- `assign()`
- `replace()`
- `reload()`
- `toString()`

`pushState` handling:

1. If no input URL is provided, keep the current virtual URL.
2. Resolve the input URL against the current virtual URL.
3. Perform same-origin checks.
4. Generate a new entry id.
5. Store the target URL in tab state.
6. `pushState` the browser URL to `/v/<tab-id>/e/<entry-id>`.
7. Do not reload.

`replaceState` replaces only the current entry. `popstate` dereferences `/v/<tab>/e/<entry>` and restores the virtual location.

Making the native `window.location` descriptor identical to the target is not a goal. Differences are treated as `ACCEPTABLE_DIVERGENCE`, but direct network escape is not allowed.

## 16. Cookie Jar

Target `Set-Cookie` values are not stored in the browser cookie jar.

```ts
type CookieRecord = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  expires?: number;
  maxAge?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Lax" | "Strict" | "None" | "Unspecified";
  creationTime: number;
  lastAccessTime: number;
};
```

`document.cookie` getter:

- Uses the current virtual URL
- Returns only `HttpOnly=false` cookies
- Applies domain/path/secure/expiry checks
- Returns the browser-compatible `name=value; name2=value2` string

## 17. Safe Internal Error Pages

ZeroProxy must provide internal error pages for controlled failure modes. These pages are same-origin internal assets under `/__zp/error/*` and must not fetch target resources.

Required error classes:

- `BAD_HMAC`
- `INVALID_SHARE_LINK`
- `MALFORMED_ROUTE`
- `SW_NOT_READY`
- `TARGET_PROTOCOL_BLOCKED`
- `TLS_CERTIFICATE_INVALID`
- `TLS_HANDSHAKE_FAILED`
- `TARGET_CONNECT_FAILED`
- `MALFORMED_HTML`
- `REALM_INJECTION_FAILURE`
- `POLICY_BLOCKED`

Error page rules:

- Do not expose raw upstream stack traces.
- Do not include share keys, cookies, authorization headers, or full request bodies.
- Show enough information for user action: target host, high-level error class, and retry/back controls.
- Preserve the invariant that the browser never falls back to direct target network access.

## 18. Threat Model and Mandatory Successor Review

The successor must review the design against these bypass vectors before implementation is accepted.

### 18.1 Dynamic Iframe Escape

Attack: target JavaScript creates an empty iframe, obtains `iframe.contentWindow`, and calls clean native APIs such as `fetch`, `WebSocket`, or `RTCPeerConnection` from that unpatched realm.

Required defense:

- Synchronous iframe insertion hooks must patch the child realm before returning control.
- Runtime tests must cover `createElement + appendChild`, `innerHTML`, `insertAdjacentHTML`, `srcdoc`, and delayed `src` assignment.
- Calling `iframe.contentWindow.fetch`, `iframe.contentWindow.WebSocket`, and `iframe.contentWindow.RTCPeerConnection` must route through ZeroProxy wrappers or throw the configured blocking exception.

### 18.2 Worker Global Escape

Attack: target JavaScript starts `new Worker()` or `new SharedWorker()` and uses that independent global scope to call native network or WebRTC APIs, bypassing the main-window IIFE.

Required defense:

- Worker constructors must be hooked before target scripts run.
- Every worker must boot through a ZeroProxy-controlled prelude.
- Worker-scope network APIs must route through the Service Worker/Go WASM transport or be blocked.
- Worker-scope WebRTC and device APIs must throw blocking `DOMException`s.
- Runtime tests must cover external worker URLs, Blob workers, data URL workers where supported, `importScripts`, and SharedWorker.

### 18.3 Direct Navigation Escape

Attack: target JavaScript assigns `location.href`, calls `location.assign`, submits a form, or triggers native top-level navigation to a cross-origin target.

Required defense:

- Static HTML laundering rewrites document navigation URLs before target code sees them.
- Runtime click/form/location/history hooks rewrite dynamic navigation to `/v/<tab-id>/n/<base64url_target_url>`.
- CSP keeps `form-action 'self'` and `navigate-to 'self'`.
- Service Worker blocks every unclassified cross-origin request.
- Tests must prove that native top-level navigation never leaves the ZeroProxy origin.
