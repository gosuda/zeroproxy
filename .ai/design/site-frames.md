# Site-Isolated Frames

A frame that belongs to another site than the top document runs in its own browser process, as it does natively. This document describes how that is achieved on a loopback relay, what state each part holds, and where the design stops.

## Why

Every proxied frame is served from one real origin, so the browser puts a frame and its embedder in the same process and lets them share a main thread. Natively, a frame of another site is isolated (an out-of-process frame). Pages can tell: a verification widget such as Cloudflare Turnstile fails when it shares its embedder's process, even with no membrane involved (a native page whose widget frame was forced into its embedder's process fails 4 of 4; see the ERRATA Glassdoor row). Observable differences include the postMessage round trip (about 0.4 ms across processes, 0.03 ms inside one), `performance.memory` bucketing, long-task and long-animation-frame attribution, and the `measureUserAgentSpecificMemory` breakdown.

## Where it applies

Only to a relay reachable under a loopback name (`proxy.localhost`, `localhost`). `<label>.localhost` names resolve to loopback, are secure contexts, and each label is a site of its own, so a frame served from `s-<site>-<hash>.localhost` is isolated from the embedder at `proxy.localhost`. A relay on a real domain cannot do this: subdomains of one registrable domain are the same site. `ZP.siteFrameCapable(origin)` is the single test.

The feature is opt-in per tab (the launcher's "Site-isolated frames" box). A tab records `siteFrames`; its documents learn it through the boot configuration.

## Which frame goes where

`ZP.siteOf(url)` is scheme plus registrable domain. For a frame of `target` embedded by a document of a tab:

| Frame's site | Served from |
|---|---|
| Same as the top document's | the main origin (where the top document lives) |
| Any other | `ZP.siteFrameOrigin(mainOrigin, target)`, one host per site |
| Opaque (sandboxed without `allow-same-origin`) | unchanged: the document's own origin |

`activatedFrameURL` in `web/membrane/04-navigation.js` makes the choice. A frame whose host equals the embedding document's own origin keeps the existing route registration (`FRAME_ROUTE`).

## Booting a site frame

The frame's first response comes from the relay, because no worker exists yet at that origin:

1. The embedder sets the frame's `src` to `<site origin>/zp/p/<encrypted target>#k=<key>&server=...&zpf=<embedder description>`. `zpf` is base64url JSON: the embedder's real origin and virtual URL, the top document's virtual URL, the main origin, and whether challenge compatibility is armed.
2. The relay answers `/zp/p/*` for an iframe on a loopback host with the launcher page, `frame-ancestors http://*.localhost:<port>`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin` (a page that demands cross-origin isolation can embed only frames that opt in). Every other response keeps `frame-ancestors 'none'`.
3. The launcher registers the site's worker (service workers and storage are partitioned by top-level site, so each embedding top-level site registers its own), decrypts the target with the key from the fragment, and sends `OPEN_SHARE` with the `siteFrame` description. The worker creates a tab born as a frame: the embedder's address is the Referer, the top document's origin decides what counts as cross-site, and the entry is marked `frameRoute`.
4. The launcher replaces the location with the worker's route. If the worker restarts and forgets the route, the same launcher page boots it again from the fragment, which is why `zpf` stays in the URL.

Each site host has its own worker, cookie jar (shared per registrable domain inside that worker), tab state and kernel connection. State is not shared with the main origin's worker.

## Policy that follows

- The embedder's CSP `frame-src` and `child-src` admit `<scheme>://*.localhost:<port>` for tabs with site frames. A target's own `<meta>` CSP is merged the same way (`filter_meta_csp_with` in Rust, `ZP.filterMetaCSP` in JS), so it cannot shut the site hosts out.
- A frame's window is unreachable for the embedder (cross-origin to the browser): `containFrameWindow` leaves it alone, `contentDocument` is `null`, and the membrane's cross-origin window stand-in wraps the real cross-origin window.
- `postMessage` is addressed to the real origin of the target window (`realOriginOfWindow`): a site frame's host, the embedder's origin, or the main origin for the top document. `MessageEvent.origin` and `source` are virtualized back from those real origins. A document in a site frame learns who embeds it from `boot.siteFrame`.

## Limits

- Loopback relays only (see above).
- First load of a site pays the worker registration (about 170 ms measured) and a launcher round trip.
- Frames nested below a site frame follow the same rule using the top document's site from `boot.siteFrame.topUrl`.
- Cookies and storage of a site written by a site frame are not visible to the same site opened as a top-level page (separate worker, separate partition).
