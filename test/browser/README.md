# Cross-Site Browser Audit Probes

[`test/browser/audit.mjs`](audit.mjs) opens a target URL through ZeroProxy and measures it across three orthogonal axes: **isolation**, **fidelity**, and **console noise**. Use it to verify that compatibility fixes generalize across websites rather than masking symptoms on a single page.

```bash
node test/browser/audit.mjs "https://developer.mozilla.org/en-US/docs/Web/API/fetch" 15000
```

## 1. The Three Audit Axes

The audit script inspects browser network recordings and DOM state to classify findings into three buckets:

| Axis | What It Measures | Failure Indicator |
| :--- | :--- | :--- |
| **Isolation** | Whether the browser's own network log (`dump-recording`) shows any request leaving the proxy origin directly | `outsideOrigins` is non-empty |
| **Fidelity** | Unrewritten resource URLs, broken images, and failed stylesheets | Non-zero `unproxiedN`, `broken`, or `deadSheets` |
| **Noise** | CSP violations, HTTP 403 responses, rejected styles, `postMessage` origin mismatches, and uncaught exceptions | Increased `console` error counts |

Any non-zero value on the **Isolation** axis indicates a containment breach, whereas **Fidelity** and **Noise** measure rendering and runtime compatibility. Evaluating all three axes together prevents misdiagnosing a blocked leak as a harmless rendering glitch (see the [hole matrix guide](hole-matrix/README.md)).

## 2. Always Compare Against a Native Control Run

Inspecting proxied numbers in isolation often misattributes a website's own behavior to the proxy:

- News and portal homepages (such as NAVER) rotate feed topics and ad slots on every load even in a native browser.
- Ad-heavy pages frequently throw thousands of third-party script exceptions natively.

Always open the same URL directly in `taskweaver` without the proxy and run the same probe to establish a control baseline. Treat only discrepancies that are zero in the native control run and non-zero under ZeroProxy (such as proxy-specific 404s or `Illegal invocation` TypeErrors) as proxy defects.

## 3. Probe Authoring Pitfalls

Keep these execution rules in mind when inspecting a proxied page with `taskweaver`:

- **`exec-js --script` runs unrewritten code**: Target page scripts read the virtual location via `__zp_get(globalThis, "location")`, whereas raw snippets injected via `exec-js` read the physical global object and see the proxy URL. Call `window.__zp_get(globalThis, ...)` explicitly when measuring what target scripts observe.
- **DOM property masking vs. isolated world**: The membrane unwraps `.src` getters and `getAttribute` calls back to the target URL. Pass `--world isolated` when you need to inspect the actual rewritten DOM attributes.
- **Cross-origin iframe `contentDocument`**: In a native control run, third-party ad and widget iframes are cross-origin and return `contentDocument === null`. Do not use cross-frame DOM node counts as a differential metric between native and proxied runs.
- **Stylesheet links without `href`**: `<link rel="stylesheet">` elements that store alternate theme URLs in `data-href` with an empty `href` (used by sites like GitHub) are inactive theme templates, not broken stylesheets (`deadSheets`).

## 4. Prototype Shape Verification (`protoshape.sh`)

[`test/browser/protoshape.sh`](protoshape.sh) compares the own-property sets of every built-in interface prototype in a proxied tab against a native control tab:

```bash
sh test/browser/protoshape.sh
```

- **Why it matters**: If a membrane helper walks a prototype chain and defines a wrapped accessor (such as `style`) directly on every subclass prototype instead of only the owning interface (`HTMLElement.prototype`), the number and placement of own properties diverge from native browsers. Libraries that inspect prototype descriptors or check `'port' in SharedWorker.prototype` can fail or flag the environment.
- **Exhaustive native constructor discovery**: Rather than checking a hand-picked list of interfaces, the probe enumerates every uppercase global property whose constructor is a native function, automatically filtering out page-defined classes.
- **Guarding against failed measurements**: If the browser renderer crashes or fails to respond, a naive diff reports zero differences. `protoshape.sh` checks that measurement succeeded (`NO_MEASUREMENT`) before comparing shapes. Exit codes: `0` (exact match), `1` (measurement failure), `2` (prototype shape mismatch).
