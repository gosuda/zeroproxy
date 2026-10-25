# Subresource Containment Escape Matrix (Hole Matrix)

The hole matrix ([`test/browser/hole-matrix/`](.)) is a browser diagnostic runner that exercises every static and dynamic DOM surface capable of initiating a network request and measures **fidelity** and **isolation** simultaneously. Running the matrix requires a live `taskweaver` browser instance and two local fixture servers.

## 1. Why Both Axes Are Measured Together

Observing only one axis produces false verdicts:

- **Fidelity only (whether bytes reached the fixture server)**: A request routed properly through the ZeroProxy relay arrives at the same fixture server and URL as a direct browser leak (and from the same source IP when running with `-socks internal`). Arrival alone does not tell you whether the request went through the proxy tunnel or bypassed it.
- **Isolation only (whether the browser's network log recorded a direct external request)**: Inspecting `dump-recording --filter network` shows whether the browser attempted to contact an external origin, but cannot distinguish a request that was rewritten properly from one where the rewriter missed the URL and Content Security Policy blocked the leak as a last resort.

Combining both signals yields an unambiguous three-state verdict:

| Browser Direct Attempt | Fixture Server Arrival | Verdict | Meaning |
| :---: | :---: | :--- | :--- |
| `O` | `O` | **Leak** | Bytes left the browser directly to the target origin, bypassing ZeroProxy |
| `O` | `X` | **`csp-only`** | The rewriter or membrane missed the URL; only the backup CSP header blocked network egress |
| `X` | Any | **`ok`** | The rewriter and membrane captured and routed (or intentionally neutralized) the URL before the browser attempted direct egress |

## 2. Intentionally Blocked Surfaces (Where Non-Arrival Is Expected)

Several HTML and Web API surfaces are intentionally blocked for security containment. For these cases, non-arrival at the fixture server (`X`) is the expected result rather than a compatibility bug:

- **`b8b-prefetch-link` (`prefetch`, `modulepreload`, `preconnect`, `dns-prefetch`, `prerender`, `manifest`)**: Resource hints such as `preconnect` leak target hostnames directly to the OS DNS resolver and are stripped. A dynamic `preload` (`b8-preload-link`) is not stripped: its `href` is rewritten like any subresource's and it loads through the proxy, because pages wait on its `load`/`error` (React 19 holds its first commit on it).
- **`b9-object-data`, `b10-embed-src`, `a23-static-object-cross` (`<object>`, `<embed>`)**: Plugin surfaces are blocked by `object-src 'none'`. Note that whether loading is permitted (enforced by CSP) and whether the raw target URL may remain in the DOM (enforced by the rewriter) are separate invariants. Both `zp-htmltx` and page-realm DOM hooks (`isURLBearing`) rewrite `<object data>` and `<embed src>` attributes so the browser never attempts a direct connection that registers as `csp-only`.

  | Question | Policy | Enforcing Layer |
  | :--- | :--- | :--- |
  | Is the plugin resource allowed to load? | **No** | CSP (`object-src 'none'`) |
  | May the raw target URL remain in the DOM? | **No** | HTML and DOM rewriters (`zp-htmltx`, `isURLBearing`) |

- **`c11-ping-attr` (`<a ping>`)**: Native `<a ping>` dispatches direct background requests to a whitespace-separated list of URLs. ZeroProxy strips the native `ping` attribute into `data-zp-ping` and sends a proxied keepalive POST on click.
- **FedCM (`navigator.credentials.get({ identity })`)**: The Federated Credential Management API requires the browser to contact the Identity Provider (IdP) directly outside page and Service Worker control, violating the single-egress invariant. ZeroProxy blocks FedCM calls.
- **Uncontrolled child frame images (`e1-adframe-img`, `e4-blank-iframe-img`)**: Iframes populated via `document.write` or `about:blank` may not register as direct Service Worker clients. The parent realm intercepts their image loads, fetches the bytes through the parent's Service Worker tunnel, and supplies a `blob:` URL so all traffic still exits through a single tunnel.

## 3. Running the Matrix

> [!IMPORTANT]
> Always pass `--enforce-csp` when starting `taskweaver`. By default, `taskweaver` disables CSP enforcement (`csp_bypassed: true`), which makes unrewritten URLs leak or appear to pass without testing the real proxy policy. Check `taskweaver list` before running the suite.

1. Start the ZeroProxy server serving compiled assets from `dist/web`.
2. Start the local fixture servers (`18099` for same-origin, `18098` for cross-origin).
3. Start the `taskweaver` `zp` instance with network recording and CSP enforcement enabled.
4. Run the matrix runner script.

```bash
# 1) Start the proxy server (always use dist/web)
./dist/zeroproxy-server -web "$(realpath dist/web)" -addr 127.0.0.1:18080 -socks internal

# 2) Start the fixture servers (18099 = same-origin, 18098 = cross-origin)
node test/browser/hole-matrix/server.mjs

# 3) Start the browser with recording and CSP enforcement enabled
taskweaver start --id zp --width 1200 --height 800 --record --enforce-csp

# 4) Run native control load followed by proxied load and print the verdict table
node test/browser/hole-matrix/run.mjs
```

## 4. Interpreting Results and Catching Regressions

When fixing a failing matrix cell, never inspect only the single cell you targeted. Always compare the **entire verdict table** before and after your change. For example, a temporal dead zone (TDZ) exception inside a CSS or DOM hook can abort membrane installation in child iframes, silently regressing unrelated iframe cells while the targeted CSS cell passes.

## 5. Static Parsing Group (`a1` to `a23`) Design

The static group (`a1` through `a23`) tests `(tag, attribute)` pairs that trigger immediate browser requests during initial HTML parsing without executing any JavaScript (including `<input type="image" src>`, `<video poster>`, SVG `<image href>` and `xlink:href`, legacy `<image src>`, and legacy `background` attributes):

- **All static cells use cross-origin (`cross`) URLs**: A relative same-origin URL left unrewritten by `zp-htmltx` still resolves against `proxy.localhost` and hits the Service Worker, hiding the missing rewrite rule. Using explicit cross-origin URLs ensures any missed attribute immediately registers a direct external request attempt.
- **`a20-static-use` (cross-origin SVG `<use href>`)**: Native browsers block cross-origin `<use href>` loads under same-origin SVG rules. Because ZeroProxy rewrites external subresources into same-origin proxy routes, the request succeeds through the proxy tunnel. Since all bytes travel through the proxy, this is not an isolation leak, but an expected consequence of single-origin virtualization.
