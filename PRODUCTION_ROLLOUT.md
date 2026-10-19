# ZeroProxy Operational Dogfood and Rollout

This runbook defines the operator verification checklist, runtime monitoring signals, and rollback procedure for ZeroProxy deployments. Passing automated CI tests does not substitute for multi-day operational verification across live websites. Current compatibility scope and active engineering tracks live in the [website compatibility refactor plan](.ai/design/website-compat-refactor.md).

## Pre-Flight Checklist

Complete these checks before starting an operational dogfood cycle:

- Verify remote CI and browser E2E results for the exact candidate commit, including the E1 containment escape matrix.
- Back up a known-good deployable build and record its commit SHA before rebuilding. [`scripts/build.mjs`](scripts/build.mjs) cleans `dist/` before compilation; confirm toolchain availability before replacing a working `dist/` directory.
- Serve compiled assets from `dist/web`, never from the source `web/` directory. See the [README quickstart instructions](README.md#quickstart).
- Record whether the relay uses an external Tor SOCKS5 listener or `-socks internal`. Internal mode connects directly from the relay host and does not provide network anonymity. Optional WebTransport and WebRTC TURN gateways require explicit flag configuration and separate validation.
- Keep Content Security Policy headers and fail-closed routing and rewrite rules enabled. Any containment escape or disabled security boundary blocks rollout.

## Stage 1: Operator Dogfood (5 to 7 Days)

Record the candidate commit SHA, browser version, target URL, transport mode, screenshots, and observed failures at each checkpoint:

- **Day 0:** Capture a baseline using `npm run dogfood:baseline` or `node scripts/dogfood-baseline.mjs https://gosuda.org`. The script connects to a relay at `127.0.0.1:18080`, drives the shared `taskweaver` `zp` instance, and writes evidence under `.ai/dogfood/<YYYY-MM-DD>/`. Inspect the encrypted `/zp/p/` route and the rendered page layout, not only the document title.
- **Days 1 to 5:** Exercise authentication flows, single-page application (SPA) navigation, and media playback. Record what succeeds or fails, and capture any `MALFORMED_HTML`, `REALM_INJECTION_FAILURE`, or `REWRITE_FAILED` error pages alongside the action that triggered them.
- **Day 6:** Audit collected logs for regressions and containment failures. Halt the rollout immediately if any direct network egress or uncontained realm execution appears.
- **Day 7:** Verify cookie and storage persistence across a full browser restart and record the outcome.

When running manual checks on a memory-constrained host, reuse the single `taskweaver` `zp` instance rather than launching additional browser processes.

## Stage 2: Test Cohort (3 Users, 1 Week)

Expand testing to a three-user cohort after Stage 1 completes without containment failures:

- Have each participant record the candidate commit SHA and daily browsing outcomes across a one-week window.
- Inspect server logs and browser console errors daily, including subresource or script failures that leave the page title unchanged.
- Preserve screenshots and reproduction steps for any user-visible regressions and resolve rollout blockers before advancing.
- Use automated real-site regression suites (`npm run dogfood:real-site`) to supplement manual cohort testing rather than replace it.

## Monitoring Signals

Monitor the following runtime signals across both dogfood stages:

| Signal | What to Inspect |
| :--- | :--- |
| **Malformed or rewrite error pages** | Failing URL, content type, triggering user action, and confirmation that the failure stayed contained. |
| **Realm injection failures** | Bootstrap script ordering, bundle version mismatches, and any target script execution prior to membrane installation. |
| **`SW_NOT_READY` responses** | Service Worker registration state, `dist/web/__zp/` asset availability, and initialization errors. |
| **Cookies and storage** | Login session continuity, storage persistence across restarts, write errors, and cross-origin tab isolation. |
| **Rewrite cache** | Warm-session latency and cache invalidation behavior across script updates. |
| **WASM and renderer memory** | Compiled artifact sizes under `dist/web/__zp/`, cold-load latency, and browser tab memory growth over time. |
| **Visible page compatibility** | Layout integrity, client-side routing, media playback, and console or network errors beyond HTTP status codes. |

Run these commands against an active `taskweaver` `zp` instance to inspect per-tab diagnostics:

```sh
taskweaver console-logs -i zp --level error --max 50
taskweaver pause -i zp
taskweaver network-log -i zp --since-ms 30000 --url-pattern '/zp/'
```

## Rollback Procedure

Execute these steps in order if a containment breach or severe regression occurs during dogfooding:

1. Halt the rollout and archive the failing commit SHA, server logs, and browser diagnostic artifacts.
2. Redeploy the backed-up known-good `dist/` build rather than rebuilding from source over the existing artifacts.
3. Restart `zeroproxy-server` with the verified asset directory and SOCKS5 transport flags.
4. Verify recovery in an isolated test profile or reset proxy site data after saving diagnostic evidence.
5. Reproduce the failing scenario against the rolled-back build and add regression coverage before attempting another rollout.

## Release Decision

Record an explicit sign-off decision tied to the candidate commit SHA and its collected verification artifacts. Any unverified transport mode, site compatibility gap, persistence limitation, or optional gateway configuration must be documented explicitly in the release notes.
