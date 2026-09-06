# ZeroProxy Operational Dogfood and Rollout

This is an operator checklist, **not a declaration of production acceptance**. The old Phase 2 gate table, historical test counts, and claim that automated regression substitutes for a week of dogfood have been retired. Current implementation work and known gaps are tracked in the [website compatibility refactor plan](.ai/design/website-compat-refactor.md).

## Before starting

- Review remote CI and browser E2E results for the exact candidate commit, including the E1 escape matrix. Do not infer present readiness from historical green runs.
- Preserve a known-good deployable build and its commit identifier before replacing it. [`scripts/build.mjs`](scripts/build.mjs) may clean `dist/` before compilation; do not destroy the only runnable build to discover a missing toolchain.
- Serve built `dist/web` assets, not source `web/`. Follow the [README build/run instructions](README.md#build-and-run-locally).
- Record whether the relay uses Tor SOCKS5 or `-socks internal`. Internal mode is direct relay egress, not an anonymity test. Optional WebTransport/WebRTC gateways need their own configuration and validation; do not assume they are enabled or validated.
- Keep CSP and fail-closed routing/rewrite behavior intact. An escape or disabled security boundary is a rollout blocker, not a compatibility workaround.

## Stage 1 — Operator dogfood (5–7 days)

Record the candidate commit, browser version, target URL, transport mode, screenshots, and observed failures at each checkpoint. These are prospective checks; none is marked complete here.

- **Day 0:** capture a baseline with `npm run dogfood:baseline`, or `node scripts/dogfood-baseline.mjs https://gosuda.org`. The helper expects a relay at `127.0.0.1:18080`, drives the shared taskweaver `zp` instance, and writes `.ai/dogfood/<YYYY-MM-DD>/` artifacts. Check the encrypted `/zp/p/` route **and the target content/layout**, not only the title.
- **Days 1–5:** exercise login, an SPA navigation flow, and a media site. Record what actually succeeds or fails; an error page is not proof of media compatibility. Capture `MALFORMED_HTML`, `REALM_INJECTION_FAILURE`, and `REWRITE_FAILED` errors with the action that triggered them.
- **Day 6:** review regressions and containment failures. Halt if a new network/realm escape appears.
- **Day 7:** explicitly exercise cookie/storage persistence across browser restart. Record the result instead of assuming persistence or login semantics are complete.

For this optional local manual workflow, use only the existing taskweaver `zp` instance. Avoid adding browser processes on a memory-constrained host; prefer remote browser evidence until resources permit manual dogfood.

## Stage 2 — Test cohort (3 users, 1 week)

- Each participant records the candidate version and actual browsing outcomes throughout the week.
- Review server logs and browser errors daily, including failures that do not change the page title.
- Preserve evidence of user-visible regressions and resolve rollout blockers before advancing.
- Automated real-site regression supplements this observation window; it does not establish that the calendar window or cohort ran.

## Monitoring signals

| Signal | What to inspect |
|---|---|
| Malformed/rewrite error documents | Failing URL, content type, triggering action, and whether failure remains contained. |
| Realm injection failures | Bootstrap ordering, bundle/version mismatch, and target script execution before containment. |
| `SW_NOT_READY` | Service Worker activation, generated asset availability, and initialization errors. |
| Cookies/storage | Login continuity, persistence, write failures, and cross-origin/tab isolation. |
| Rewrite cache | Warm-session behavior and cache invalidation; do not substitute an old hit-ratio target for measurement. |
| WASM/renderer memory | Built artifacts under `dist/web/__zp/`, cold-load cost, and browser memory against the same baseline. |
| Visible compatibility | Layout, navigation, media, and console/network errors in addition to title and HTTP status. |

Per-tab diagnostic commands for an already-running taskweaver `zp` instance:

```sh
taskweaver console-logs -i zp --level error --max 50
taskweaver pause -i zp
taskweaver network-log -i zp --since-ms 30000 --url-pattern '/zp/'
```

## Rollback

1. Halt rollout and preserve the failing commit, logs, and browser artifacts.
2. Redeploy the identified known-good build; do not rely on an obsolete branch name or rebuild over the only good artifact.
3. Restart the managed server with the same documented asset path and transport configuration.
4. Retest with an isolated test profile or deliberately reset test state after preserving needed evidence. Do not clear an operator's browsing profile as a routine shortcut.
5. Repeat the failing scenario and baseline before resuming. Document the regression and the missing coverage.

## Release decision

Record an explicit operator decision against the exact candidate commit and its evidence. Passing CI, strict mode being the only mode, a release tag, or historical checkmarks alone does not prove production readiness. Any untested Tor behavior, site compatibility, persistence, or gateway configuration remains an explicit gap.
