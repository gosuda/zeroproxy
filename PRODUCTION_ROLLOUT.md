# ZeroProxy Production Rollout (Phase 2 → strict default)

Operational record for activating strict mode as the only production
mode after Phase 2 acceptance. References [`PHASE2_STATUS.md`](PHASE2_STATUS.md)
for the gate checklist.

---

## Pre-rollout invariants

| Invariant | How to verify | Status |
|---|---|---|
| No `compatMode` / `defaultMode` toggle in user-facing code | `grep -rnE 'defaultMode\|compatMode\|STRICT_MODE_DEFAULT' web/ internal/ cmd/` returns no user-facing switches (only `installBlockers(w, strict)` internal parameter — defense-in-depth layering, not a mode) | ✅ |
| Server CLI exposes no compat flag | `cmd/zeroproxy-server/main.go` flags: `addr` / `web` / `socks` — no mode switch (Server-side TLS listener removed 2026-06-08 in commit `50f6667`; target TLS handshake lives in the Rust kernel client.) | ✅ |
| All P0 + P1 + P2 strict-mode gates closed | [`PHASE2_STATUS.md`](PHASE2_STATUS.md) checklist | ✅ (`C1` boundary done, transport carry-over; `D2/D4/D5` stubs with explicit error pages) |
| Build artifacts identical between dev + prod (no `--release` only branches) | `cargo build --release` produces the same artifact layout as dev | ✅ |
| Test suites green | `cargo test --workspace` (180+ Rust unit, all pass), `go test ./...`, `node test/js/static-policy.test.js` (41/41 pass post split-bundle c.1→c.3) | ✅ |

---

## Rollout sequence

### Stage 1 — Dogfood (5–7 days)

Operator runs ZeroProxy on their primary browsing profile. Daily journal:

- [ ] **Day 0** baseline capture via `npm run dogfood:baseline` (or `node scripts/dogfood-baseline.mjs https://gosuda.org`). The helper drives the shared `taskweaver --id zp` instance through the launcher, opens the target, screenshots the result, dumps console errors, and writes `.ai/dogfood/<YYYY-MM-DD>/{baseline.png,console-errors.json,summary.md}`. Pre-req: `./dist/zeroproxy-server.exe -web "$(realpath dist/web)" -addr 127.0.0.1:18080 -socks internal` running. Confirm `/zp/p/` route + home cards render in `baseline.png`.
- [ ] **Day 1–5** daily browsing checkpoint:
  - Login to one webmail (NAVER / Gmail)
  - Navigate one SPA (single React dashboard or doc site)
  - Open one media site (YouTube → fail-gateway page expected; D5 stub)
  - Track any `MALFORMED_HTML` / `REALM_INJECTION_FAILURE` / `REWRITE_FAILED` page appearances in trap notebook
- [ ] **Day 6** review `.ai/trap-notebook/` entries → if any new "탈출 없는 감옥" violation surfaced, halt and treat as P0 regression
- [ ] **Day 7** confirm `cookieJar` IDB persistence: close all browser windows, reopen, NAVER NACT cookie survives → no 60s anti-credential-stuffing replay

### Stage 2 — Test-cohort production (3 users, 1 week)

- [ ] Each operator runs ZeroProxy as their only proxy for the cohort week
- [ ] Daily check: server logs (`zeroproxy listening on ...` + `[ERR]` lines), browser console errors (per-tab via `taskweaver console-logs -i <id> --level error`)
- [ ] Weekly summary: any user-visible regression → file as trap-notebook entry, otherwise advance

### Stage 3 — Strict default activation

- [ ] Tag the release: `git tag phase2-strict-default`
- [ ] Update `README.md`'s status badge to "Phase 2 strict default"
- [ ] Push trap-notebook entries upstream for future cycle visibility
- [ ] Sweep `[~]` partial gates in [`PHASE2_STATUS.md`](PHASE2_STATUS.md) — if any have shifted to `[x]`, mark closed

---

## Monitoring signals

| Signal | Source | Threshold for rollback |
|---|---|---|
| `MALFORMED_HTML` error page count | SW `safeError('MALFORMED_HTML', ...)` invocations | > 1% of document-class responses → rollback |
| `REALM_INJECTION_FAILURE` count | foreground OXC bootstrap timeout / version mismatch | any sustained occurrence → investigate before continuing |
| `SW_NOT_READY` count | SW boot failure | > 0.1% of `/zp/` loads → halt rollout, inspect SW boot path |
| Cookie jar IDB write latency | `flushDirtyJarsToIDB()` p95 | > 200 ms p95 → quota pressure; review eviction policy |
| Rewrite cache hit ratio | `rewriteCache` LRU + size | < 30% on warm session → key derivation may be over-specific, investigate |
| WASM bundle size | `dist/web/__zp/zp_bundle_bg.wasm` | regression > +10% triggers a size-track review |

### Per-tab quick check (taskweaver)

```bash
taskweaver console-logs -i zp --level error --max 50
taskweaver pause -i zp                 # if a page wedges
taskweaver network-log -i zp --since-ms 30000 --url-pattern '/zp/'
```

---

## Known carry-over (Phase 3 candidates)

These are documented in [`PHASE2_STATUS.md`](PHASE2_STATUS.md) `Phase 2 follow-up` and do NOT block strict-default activation — each has a graceful fail surface (error page + stub `code:` error):

- ~~**C1 WS transport**~~ — landed. RFC 6455 handshake + frame codec + JS surface in [`crates/zp-kernel-bundle/src/kernel/transport/ws_client.rs`](crates/zp-kernel-bundle/src/kernel/transport/ws_client.rs) (moved from `zp-bundle` in split-bundle c.3); `kernel_stream` no longer returns the `TARGET_WS_NOT_REWIRED` stub.
- ~~**D2 sourcemap composition**~~ — landed. Rewriter map composer in [`crates/zp-rewriter/src/sourcemap.rs`](crates/zp-rewriter/src/sourcemap.rs) + SW `/zp/api/sourcemap` route + rewriter pragma append; DevTools breakpoints land on the original identifier. Chained map (rewriter_map ∘ original_map) wired via `composeSourceMapChained` export.
- ~~**Patch-mode wire-up in SW**~~ — landed. SW prefers `rewriteScriptPatches` + `applyScriptPatches` over the full re-emit path. (Note: post split-bundle c.1 the JS-side patch envelope was retired in favour of full re-emit on the SW hot path — see PHASE2_STATUS.md E3 (c.1) entry — because patch-mode markers can't be resolved JS-side. Rust-side patch API stays for host-side benchmarks.)
- ~~**split-bundle (c.1 / c.2 / c.3)**~~ — landed 2026-06-08. (c.1) deleted legacy rewriter-rs/ + ported CSS rewriter to zp-bundle. (c.2) split page realm into `crates/zp-page-bundle` (~0.81 MB wasm). (c.3) split SW kernel/transport into `crates/zp-kernel-bundle` (~2.37 MB) loaded lazily on first `transportFetch`. SW activate-path footprint **3.84 MB → 1.45 MB** (-64%).
- **wasm-opt bundle ceiling** — `zp_bundle_sw_bg.wasm` 1.34 MB / `zp_kernel_sw_bg.wasm` 2.37 MB (lazy) / `zp_page_bundle_bg.wasm` 0.81 MB. Hard target ≤ 500 KB still requires a Phase 3 streaming-parse architecture (split-bundle already exhausted).
- **D4 WebTransport** — virtual surface ✅; quic-go HTTP/3 listener deferred (`WT_UNSUPPORTED` error page). Full implementation queued post-E4.
- **D5 WebRTC** — virtual surface ✅; pion SFU/TURN deferred (`RTC_GATEWAY_UNAVAILABLE` error page). Full implementation queued post-E4.

---

## Rollback procedure

If a P0 / P1 regression surfaces during dogfood or cohort week:

1. Revert the last commit on `feat/riir-wasm` that introduced the regression
2. `npm run build` → confirm artifacts rebuild
3. Restart server: `pkill zeroproxy-server`, then re-launch with the same `-web dist/web` path
4. Clear the test browser profile (taskweaver `--id zp` daemon retains Chromium state across kill/start — see trap-notebook `taskweaver-profile-state` entry)
5. Re-run the dogfood baseline (gosuda.org screenshot) before resuming the rollout
6. File a trap-notebook entry documenting the regression vector + the gate that should have caught it

---

## Acceptance signal

Strict default is **production-active** when all three are true:

- ✅ Stage 1 dogfood complete with 0 user-visible "탈출 없는 감옥" violations
- ✅ Stage 2 cohort week complete with no rollback triggered
- ✅ [`PHASE2_STATUS.md`](PHASE2_STATUS.md) E4 row updated to `[x]` and a release tag pushed
