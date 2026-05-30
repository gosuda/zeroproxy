# Cloudflare Turnstile and Managed Challenge Compatibility Notes

Assessment date: 2026-05-30.

This document records the observable loading flow for
`https://2captcha.com/demo/cloudflare-turnstile-challenge`, the public
Cloudflare Turnstile integration contract, and the browser surfaces ZeroProxy
must preserve for legitimate user-driven compatibility.

It does not include private Cloudflare VM bytecode, opcode tables, interpreter
pseudocode, token-forging logic, or bypass/solver procedures. Those details are
not a public compatibility contract and would directly enable emulation of an
anti-abuse challenge. The actionable ZeroProxy target is compatibility with the
documented widget and with user-driven browser execution, not CAPTCHA solving.

## Evidence Collected

Commands used:

```sh
curl -I -L -A 'Mozilla/5.0' \
  'https://2captcha.com/demo/cloudflare-turnstile-challenge'

curl -L -sS -A 'Mozilla/5.0' \
  'https://2captcha.com/demo/cloudflare-turnstile-challenge'

curl -I -L -sS \
  'https://challenges.cloudflare.com/turnstile/v0/api.js'
```

Observed target response:

| Item | Value |
|---|---|
| Status | `403` |
| Server | `cloudflare` |
| Mitigation marker | `cf-mitigated: challenge` |
| Content type | `text/html; charset=UTF-8` |
| Page title | `Just a moment...` |
| Challenge type | `window._cf_chl_opt.cType === "managed"` |
| Zone | `window._cf_chl_opt.cZone === "2captcha.com"` |
| Loader path | `/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=<cf-ray>` |

The first response in this environment is therefore a Cloudflare Managed
Challenge interstitial, not the final demo application HTML.

## Observable Managed Challenge Flow

The challenge HTML performs the following high-level steps:

1. Sends a restrictive `Content-Security-Policy`.
2. Defines a nonce-bound inline script.
3. Creates `window._cf_chl_opt` with per-request opaque challenge metadata.
4. Appends a script from:

   ```text
   /cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=<cf-ray>
   ```

5. Temporarily rewrites the URL with Cloudflare challenge token query
   parameters through `history.replaceState`.
6. Restores the original URL after the orchestration script loads.

Observed `_cf_chl_opt` fields:

| Field | Compatibility meaning |
|---|---|
| `cType` | Challenge family. Observed as `managed`. |
| `cZone` | Protected zone, observed as `2captcha.com`. |
| `cRay` | Cloudflare ray id for this challenge transaction. |
| `cFPWv` | Challenge platform/channel selector. Treat as opaque. |
| `cH`, `cUPMDTk`, `fa`, `md`, `mdrd` | Per-request opaque challenge state. Treat as opaque and transient. |
| `cN` | Nonce used for the inline script and dynamically appended script. |
| `cITimeS` | Challenge issuance timestamp-like value. Treat as opaque. |
| `cTpl*`, `cvId` | Template/version selectors. Treat as opaque. |

ZeroProxy should preserve these values if it is transparently rendering the
page, but must not attempt to interpret or synthesize them.

## Challenge Headers and Policy Surface

Observed response headers relevant to browser behavior:

| Header | Compatibility implication |
|---|---|
| `content-security-policy` | Must allow the exact challenge execution model. Rewriting it can break the challenge. |
| `accept-ch` / `critical-ch` | Requests client hints such as UA architecture, bitness, full version, platform, model, and mobile state. |
| `cross-origin-embedder-policy: require-corp` | Requires compatible embedding/cross-origin resource behavior. |
| `cross-origin-opener-policy: same-origin` | Places the page in an opener-isolated browsing context. |
| `cross-origin-resource-policy: same-origin` | Restricts direct cross-origin reuse of the response. |
| `permissions-policy` | Disables many high-risk APIs while preserving the challenge's expected policy environment. |
| `referrer-policy: same-origin` | Affects downstream request referrers. |
| `x-frame-options: SAMEORIGIN` | Blocks third-party framing of the challenge page. |

Observed client-hint request list:

```text
Sec-CH-UA-Bitness
Sec-CH-UA-Arch
Sec-CH-UA-Full-Version
Sec-CH-UA-Mobile
Sec-CH-UA-Model
Sec-CH-UA-Platform-Version
Sec-CH-UA-Full-Version-List
Sec-CH-UA-Platform
Sec-CH-UA
UA-Bitness
UA-Arch
UA-Full-Version
UA-Mobile
UA-Model
UA-Platform-Version
UA-Platform
UA
```

ZeroProxy should not invent client hints. It should preserve the browser's
native client-hint negotiation as closely as possible and avoid creating
contradictions between `navigator.userAgentData`, `Sec-CH-UA-*` request headers,
and the User-Agent used by the transport layer.

Observed permissions policy:

```text
accelerometer=(),
browsing-topics=(),
camera=(),
clipboard-read=(),
clipboard-write=(),
geolocation=(),
gyroscope=(),
hid=(),
interest-cohort=(),
magnetometer=(),
microphone=(),
payment=(),
publickey-credentials-get=(),
screen-wake-lock=(),
serial=(),
sync-xhr=(),
usb=(),
xr-spatial-tracking=(self)
```

This page intentionally disables many high-risk or high-entropy APIs. A
compatibility mode should preserve the policy effect instead of re-enabling
these APIs inside the target realm.

Observed CSP shape:

```text
default-src 'none';
script-src 'nonce-<nonce>' 'unsafe-eval' https://challenges.cloudflare.com;
script-src-attr 'none';
style-src 'unsafe-inline';
img-src 'self' https://challenges.cloudflare.com;
connect-src 'self' https://challenges.cloudflare.com;
frame-src 'self' https://challenges.cloudflare.com blob:;
child-src 'self' https://challenges.cloudflare.com blob:;
worker-src blob:;
form-action http: https:;
base-uri 'self';
```

Compatibility consequences:

- `unsafe-eval` is part of the observed challenge policy.
- `blob:` workers and `blob:` child/frame contexts must not be globally blocked
  if the goal is manual challenge compatibility.
- `connect-src` must allow `https://challenges.cloudflare.com`.
- The same-zone `/cdn-cgi/challenge-platform/...` script must be routable.
- A proxy-origin document cannot blindly replace this CSP with a stricter
  ZeroProxy policy and still expect the challenge to work.

## Public Turnstile Widget Contract

Cloudflare documents the stable widget entrypoint as:

```html
<script
  src="https://challenges.cloudflare.com/turnstile/v0/api.js"
  async
  defer
></script>
```

On 2026-05-30 this URL resolved as:

```text
302 Location: /turnstile/v0/g/8fc8ed1d8752/api.js
200 content-type: application/javascript; charset=UTF-8
200 content-length: 66439
200 last-modified: Thu, 28 May 2026 15:08:54 GMT
```

Cloudflare's documentation warns that `api.js` must be fetched from the exact
documented URL. Proxying or caching this file can cause future Turnstile updates
to fail. For ZeroProxy, this means the request may be transported through
ZeroProxy's network path, but the application-visible URL and cache/update
semantics should remain Cloudflare-compatible.

Documented client surfaces:

| Surface | Required compatibility behavior |
|---|---|
| Implicit rendering | Scan `class="cf-turnstile"` containers and render widgets. |
| `data-sitekey` | Required widget site key. |
| `data-theme`, `data-size`, `data-language` | Widget configuration attributes. |
| `data-callback` / `callback` | Called with the response token on success. |
| `data-error-callback` / `error-callback` | Called with client-side error code. |
| `data-expired-callback` / `expired-callback` | Called when a token expires. |
| `data-timeout-callback` / `timeout-callback` | Called when an interactive challenge times out. |
| `turnstile.render(selector, options)` | Explicit widget creation. |
| `turnstile.reset(widgetId)` | Reset/retry a widget. |
| `turnstile.getResponse(widgetId)` | Read the current token. |
| `turnstile.remove(widgetId)` | Remove a widget from the page. |
| Hidden form input | Implicit form integration adds `cf-turnstile-response`. |

Documented widget configuration surfaces:

| JavaScript parameter | Data attribute | Compatibility behavior |
|---|---|---|
| `sitekey` | `data-sitekey` | Required widget identifier. |
| `action` | `data-action` | Customer analytics value returned during validation. |
| `cData` | `data-cdata` | Customer payload returned during validation. |
| `execution` | `data-execution` | Controls token acquisition timing: render-time or explicit execute-time. |
| `appearance` | `data-appearance` | Controls visibility: `always`, `execute`, or `interaction-only`. |
| `theme` | `data-theme` | `auto`, `light`, or `dark`. |
| `language` | `data-language` | `auto`, language code, or language-region code. |
| `tabindex` | `data-tabindex` | Iframe accessibility tab order. |
| `size` | `data-size` | `normal`, `flexible`, or `compact`. |
| `retry` | `data-retry` | `auto` or `never`. |
| `retry-interval` | `data-retry-interval` | Retry interval in milliseconds when retry is automatic. |
| `refresh-expired` | `data-refresh-expired` | Expired-token refresh behavior: `auto`, `manual`, or `never`. |
| `refresh-timeout` | `data-refresh-timeout` | Interactive-timeout refresh behavior. |
| `response-field` | `data-response-field` | Whether to create a response-token input. |
| `response-field-name` | `data-response-field-name` | Name of the response-token input; default is `cf-turnstile-response`. |
| `feedback-enabled` | `data-feedback-enabled` | Visitor-feedback UI setting. |
| `offlabel-show-privacy` | `data-offlabel-show-privacy` | Privacy-link behavior for unbranded widgets. |
| `offlabel-show-help` | `data-offlabel-show-help` | Help-link behavior for unbranded widgets. |

Documented callback surfaces:

| JavaScript parameter | Data attribute | Event |
|---|---|---|
| `callback` | `data-callback` | Challenge succeeded; receives a token. |
| `error-callback` | `data-error-callback` | Client-side error occurred; receives an error code. |
| `expired-callback` | `data-expired-callback` | Token expired. |
| `timeout-callback` | `data-timeout-callback` | Interactive challenge timed out. |
| `before-interactive-callback` | `data-before-interactive-callback` | Challenge is about to enter interactive mode. |
| `after-interactive-callback` | `data-after-interactive-callback` | Challenge has left interactive mode. |
| `unsupported-callback` | `data-unsupported-callback` | Browser/client is unsupported. |

Widget dimensions from Cloudflare's public documentation:

| Size | Width | Height |
|---|---|---|
| `normal` | `300px` | `65px` |
| `flexible` | `100%`, minimum `300px` | `65px` |
| `compact` | `150px` | `140px` |

Server-side contract:

- The protected site must validate tokens with Cloudflare Siteverify.
- Tokens expire after 300 seconds.
- Tokens are single-use.
- A client token by itself is not an authorization decision.

Sources:

- https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
- https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/
- https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/

## Managed Challenge versus Embedded Turnstile

The requested URL name contains `turnstile-challenge`, but the observed first
response is a Cloudflare Managed Challenge.

| Area | Embedded Turnstile | Managed Challenge |
|---|---|---|
| Owner | Application site embeds the widget. | Cloudflare emits an interstitial before the site page. |
| Primary script | `https://challenges.cloudflare.com/turnstile/v0/api.js` | `/cdn-cgi/challenge-platform/.../orchestrate/chl_page/v1?...` |
| Stable API | `window.turnstile` methods and callbacks. | No public VM/opcode API. |
| State | Sitekey and widget options. | Opaque request-bound `_cf_chl_opt` metadata. |
| Validation | Site backend calls Siteverify. | Cloudflare challenge platform controls clearance. |

ZeroProxy should treat these as related but distinct compatibility targets.

## Browser API Surface to Preserve

The following surfaces are relevant for legitimate challenge execution and
Turnstile compatibility. This is a compatibility checklist, not a spoofing
recipe.

### Script Execution

| Surface | ZeroProxy requirement |
|---|---|
| Classic scripts | Load from Cloudflare and same-zone challenge paths without changing execution order. |
| Nonce handling | Preserve nonce-authorized inline script execution. |
| `eval` / generated functions | Do not strip `unsafe-eval` for challenge documents if manual compatibility is required. |
| Dynamic script insertion | Preserve `document.createElement("script")`, `appendChild`, `onload`, `onerror`, `nonce`, and `src` behavior. |
| `history.replaceState` | Preserve temporary Cloudflare URL rewrites and restoration. |

### Network

| Surface | ZeroProxy requirement |
|---|---|
| `fetch` | Route without exposing direct browser egress; preserve method, credentials mode where possible, referrer policy, redirects, and CORS-visible behavior. |
| XHR | Preserve async request behavior, headers, response types, and event ordering closely enough for client code. |
| `navigator.sendBeacon` | Route same as other target network egress if used. |
| Resource loads | Route scripts, frames, images, and worker blobs according to the challenge CSP. |
| Client hints | Preserve browser-generated `Sec-CH-UA-*` and related negotiation behavior when possible. |
| Cookies | Preserve Cloudflare challenge cookies, path/domain/secure flags, and subsequent request attachment. |

Relevant resource routes:

| Route class | Required behavior |
|---|---|
| `https://challenges.cloudflare.com/turnstile/v0/api.js` | Load the documented entrypoint as Cloudflare expects; do not pin stale hashed assets. |
| `https://challenges.cloudflare.com/turnstile/v0/g/<version>/api.js` | Follow Cloudflare's redirect and cache headers without treating the hash as stable. |
| `https://challenges.cloudflare.com/*` subresources | Route through the proxy transport and preserve CORS/CORP-visible behavior. |
| `/cdn-cgi/challenge-platform/...` on the protected zone | Route same-zone challenge scripts and follow-up resources through the target transport. |
| `blob:` worker/frame URLs | Preserve when created by an allowed challenge script; keep them inside the controlled browser context. |

### Frames, Workers, and Realms

| Surface | ZeroProxy requirement |
|---|---|
| `iframe` / child frames | Allow same-zone and `https://challenges.cloudflare.com` frames permitted by CSP. |
| `blob:` frames | Do not globally block if challenge compatibility is enabled. |
| `Worker` from `blob:` | Preserve blob worker construction, script execution, and messaging where allowed. |
| `postMessage` | Preserve message delivery, origin checks, transferables, and event timing across frames/workers. |
| COOP/COEP | Keep opener/embedder policy behavior close to the browser's native isolation model. |

### DOM and Events

| Surface | ZeroProxy requirement |
|---|---|
| DOM mutation APIs | Preserve insertion/removal of challenge containers, scripts, iframes, forms, and hidden inputs. |
| Layout APIs | Preserve `getBoundingClientRect`, computed style, viewport dimensions, and resize behavior. |
| Pointer/keyboard events | Preserve trusted user interaction delivery for interactive challenges. |
| Form submission | Preserve hidden `cf-turnstile-response` submission for embedded widgets. |
| Timers | Preserve `setTimeout`, `setInterval`, microtasks, and event loop ordering closely. |

### Browser Identity and Capability Surfaces

These surfaces are often read by security widgets. ZeroProxy should avoid
creating contradictions caused by its own rewriting layer. It should not attempt
to forge a different browser identity.

| Surface | Compatibility concern |
|---|---|
| `navigator.userAgent`, `userAgentData`, platform hints | Should match actual browser/client-hint behavior as much as the browser provides. |
| `navigator.cookieEnabled`, languages, online state | Should not contradict cookie/network behavior. |
| `screen`, `visualViewport`, device pixel ratio | Should remain internally consistent with layout results. |
| `performance.now`, navigation/resource timing | Should not be broken by proxy rewriting. |
| Canvas/WebGL/Audio APIs | Do not block ordinary reads needed by the page; broad anti-fingerprint spoofing is outside scope. |
| `crypto.getRandomValues`, `crypto.subtle` | Must work normally. |
| Storage APIs | Cookies are essential; local/session storage and IndexedDB should not fail unexpectedly if used by the page. |

### Error and Retry Paths

Cloudflare documents client-side error callbacks and retry behavior. ZeroProxy
should preserve:

- `error-callback` invocation with an error code;
- automatic retry behavior unless widget options disable it;
- manual `turnstile.reset()` retry;
- timeout and expiry callback delivery;
- console warnings/exceptions when no callback handles the error.

Documented error families and examples:

| Code or family | Meaning | Retry expectation |
|---|---|---|
| `110100` | Invalid sitekey. | No. |
| `110110` | Sitekey not found. | No. |
| `110200` | Domain not authorized. | No. |
| `110600` | Challenge timed out. | Yes. |
| `110620` | Interaction timed out. | Yes. |
| `200100` | Clock or cache problem. | No. |
| `200500` | Iframe load error. | Yes. |
| `300*` | Generic challenge failure. | Yes. |
| `400020` | Invalid sitekey. | No. |
| `400070` | Sitekey disabled. | No. |
| `600*` | Generic challenge failure. | Yes. |

The exact retry decision belongs to the Turnstile widget. ZeroProxy should avoid
turning a widget error into an unrelated proxy policy error; preserving the
callback path gives the embedding page a chance to recover.

## Internal VM and Opcode Boundary

The Managed Challenge runtime may use VM-like bytecode, generated code,
obfuscation, self-checks, and per-request opaque state. The observed page
supports that conclusion because it allows generated script execution, blob
workers/frames, strict challenge metadata, and versioned Cloudflare loaders.

However, no stable opcode table is part of Cloudflare's public contract. Any
opcode mapping extracted from one request would be:

- deployment-specific;
- request-bound;
- tied to opaque challenge state;
- subject to rotation;
- directly useful for challenge emulation and bypass.

ZeroProxy documentation should therefore stop at the execution constraints and
browser compatibility surfaces listed above. It should not publish bytecode
disassembly, opcode semantics, interpreter pseudocode, token synthesis, or
automated challenge-answer procedures.

## ZeroProxy Implementation Implications

For legitimate manual compatibility, a Turnstile/Managed Challenge mode would
need to be explicit. The mode should preserve Cloudflare's public behavior while
keeping ZeroProxy's no-direct-egress invariant.

Required behavior:

1. Route `https://challenges.cloudflare.com/turnstile/v0/api.js` without
   changing the application-visible URL or pinning a stale hashed implementation.
2. Route `/cdn-cgi/challenge-platform/...` same-zone challenge resources through
   the target transport path.
3. Preserve challenge CSP semantics for scripts, frames, workers, `connect-src`,
   and `blob:` where required.
4. Preserve Cloudflare cookies and client-hint negotiation across follow-up
   challenge requests.
5. Preserve documented `window.turnstile` callbacks, hidden form input behavior,
   reset, expiry, timeout, error, and remove paths.
6. Preserve user interaction event delivery for interactive challenges.
7. Fail closed when a challenge resource would otherwise escape ZeroProxy's
   request classifier.

Current ZeroProxy friction points to review before expecting challenge
compatibility:

| ZeroProxy subsystem | Current behavior from repository docs | Turnstile/Challenge impact |
|---|---|---|
| Response CSP/header constructor | Target CSP and many policy headers are stripped and replaced with ZeroProxy CSP. | Managed Challenge pages rely on their CSP, COOP, COEP, CORP, and permissions policy. A compatibility mode would need a carefully scoped exception or equivalent policy projection. |
| Script rewriting | External, inline, worker, and dynamic scripts are laundered/re-written and parse failures fail closed. | Cloudflare challenge scripts are obfuscated, generated, and versioned. Rewriting can break semantics; a compatibility mode needs explicit treatment rather than generic source transformation. |
| Dynamic compilation | ZeroProxy wraps `Function`, `eval`, and string timers under a virtual scope. | Challenge documents explicitly allow `unsafe-eval`; wrapper fidelity and source-string masking can affect execution. |
| Blob workers | Blob/data worker scripts that cannot be synchronously rewritten may fail closed. | Observed challenge CSP allows `worker-src blob:`. Blocking blob workers can cause legitimate manual challenge failure. |
| Frames | Iframe/frame URLs are converted to encrypted `/zp/p` routes and clean realms are instrumented. | Challenge frames from `challenges.cloudflare.com` and `blob:` need compatible origin, postMessage, and policy behavior. |
| Network wrappers | Fetch/XHR/EventSource/sendBeacon are routed through `/zp/api/fetch`; semantics are prototype-level. | Turnstile error/retry paths are sensitive to network, redirect, CORS, cache, credentials, and timing differences. |
| Client hints and UA | Transport UA/client hints must remain internally consistent. | Cloudflare requests many client hints via `Accept-CH` and `Critical-CH`; contradictions can create compatibility failures. |
| Cookies | Go cookie jar owns target cookies and runtime mirrors non-HttpOnly cookies. | Challenge clearance and retry state depend on path/domain/secure/HttpOnly semantics being preserved across requests. |

Repository code touchpoints:

| File | Review focus for Turnstile/Challenge compatibility |
|---|---|
| `web/zp-core.js` | `fixedCSP()` currently defines proxy document CSP. Challenge compatibility depends on whether Cloudflare's script/frame/worker/connect policy can be projected without reopening direct egress. |
| `web/sw.js` | Request classifier, `/zp/api/fetch`, `/zp/api/script`, `/zp/api/worker-script`, `rewriteScriptResponse()`, `transportFetch()`, `addCSP()`, cookie sync, and `workerBootstrap()` determine whether challenge resources stay inside ZeroProxy and still execute. |
| `web/runtime-prelude.js` | Runtime wrappers for dynamic scripts, `fetch`, XHR, `sendBeacon`, frames, workers, `postMessage`, timers, cookies, storage, and fingerprint-masking surfaces can change challenge-visible semantics. |
| `web/worker-prelude.js` | Worker-side `fetch`, `importScripts`, and worker-script URL laundering affect `blob:`/worker compatibility. |
| `internal/headers/policy.go` | `ConstructorPolicy()` strips target security and reporting headers before browser `Response` construction. Managed Challenge pages are unusually dependent on those headers. |
| `internal/swhttp/bridge_js.go` | Converts kernel responses into browser `Response` objects and applies transformed header policy. |
| `internal/htmltx/transform.go` | Static HTML transform changes scripts, frames, links, forms, CSP-relevant attributes, and `srcdoc`. |
| `internal/zphttp/roundtrip.go` | Target request construction, redirect handling, cookies, ALPN, and request headers affect Cloudflare follow-up requests. |
| `internal/cookiejar/jar.go` | Domain/path/Secure/HttpOnly/SameSite behavior affects challenge and clearance cookies. |
| `cmd/zeroproxy-server/main.go` | Static asset CSP and worker bootstrap headers affect the proxy-origin execution environment. |

Non-goals:

- local challenge solving;
- VM emulation;
- browser fingerprint forgery;
- token replay or token synthesis;
- bypassing Cloudflare clearance.

## Safe Trace Plan

The useful trace for ZeroProxy work is an observable browser-compatibility trace,
not a VM disassembly. A trace should prove that resources, policies, callbacks,
cookies, and events flow through the expected ZeroProxy paths.

Do collect:

- navigation URL, status code, response MIME type, and response policy headers;
- request destination (`script`, `iframe`, `worker`, `image`, `fetch`, etc.);
- initiator category when available from browser devtools/protocol events;
- effective request URL origin and whether the request went through ZeroProxy;
- response redirect chain and cache headers for `api.js`;
- CSP, COOP, COEP, CORP, Permissions-Policy, Referrer-Policy, and X-Frame-Options;
- Set-Cookie metadata: name, domain, path, Secure, HttpOnly, SameSite, expiry;
- presence of callback invocation names and timing, without storing token values;
- iframe/worker/blob creation events at the API level;
- console errors, Turnstile error codes, network failures, and CSP violations.

Do not collect or publish:

- `cf-turnstile-response` token values;
- Cloudflare clearance cookie values;
- `_cf_chl_opt` opaque token values beyond field names and value categories;
- challenge script bodies intended for disassembly;
- VM bytecode, opcode tables, interpreter state, or generated answers.

Suggested trace record shape:

```json
{
  "timestamp": "2026-05-30T00:00:00Z",
  "phase": "resource-load",
  "url_origin": "https://challenges.cloudflare.com",
  "url_path_class": "/turnstile/v0/api.js",
  "resource_type": "script",
  "status": 200,
  "redirected_from": "https://challenges.cloudflare.com/turnstile/v0/api.js",
  "through_zeroproxy": true,
  "policy_headers_present": ["content-security-policy", "cross-origin-resource-policy"],
  "cookie_names_set": [],
  "callback": null,
  "error_code": null,
  "notes": "Do not store response body or token values."
}
```

Expected observable state machine:

| Phase | Observable success condition |
|---|---|
| `document-challenge` | The protected URL returns either final application HTML or a Cloudflare challenge document without direct browser egress. |
| `orchestrator-load` | Same-zone `/cdn-cgi/challenge-platform/...` scripts load through ZeroProxy and retain required CSP semantics. |
| `turnstile-loader` | Public `api.js` loads from the documented Cloudflare URL and follows Cloudflare's current redirect. |
| `widget-render` | A `cf-turnstile` container or explicit render call creates the expected iframe/widget DOM. |
| `interactive` | Pointer/keyboard/focus/layout APIs deliver normal user interaction to the widget. |
| `callback` | Documented callbacks fire in the target page realm, with tokens redacted from logs. |
| `submit` | Forms carry the configured response field name through the normal target page flow. |
| `retry-error` | Failures surface through Turnstile callbacks or documented error codes rather than ZeroProxy leaks. |

## Verification Checklist

Use these checks for compatibility work:

1. A page with an embedded Turnstile widget loads the exact documented
   `api.js` URL.
2. The request is carried through ZeroProxy's controlled transport path.
3. The widget renders inside the target page without direct browser egress.
4. `callback`, `error-callback`, `expired-callback`, and `timeout-callback`
   execute in the expected page realm.
5. `cf-turnstile-response` is added to a form and submitted through the normal
   target page flow.
6. `turnstile.reset`, `turnstile.getResponse`, and `turnstile.remove` behave
   according to Cloudflare's public API.
7. A Managed Challenge page can load its same-zone orchestrator, allowed
   Cloudflare resources, permitted frames, permitted workers, and allowed
   network endpoints without escaping the classifier.
8. Challenge cookies and client hints remain consistent across reload/retry.
9. Failure paths surface as Turnstile or Cloudflare challenge errors, not as
   ZeroProxy policy leaks or direct native fetches.

These checks validate browser compatibility. They do not validate CAPTCHA
solving or Cloudflare bypass.
