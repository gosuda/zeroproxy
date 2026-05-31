# AGENTS.md — ZeroProxy

ZeroProxy is a **human-in-the-loop** virtual-browsing privacy membrane: a real person drives a real browser, and target traffic egresses only through `Service Worker → Go WASM kernel → WebSocket/yamux → SOCKS5 → uTLS`. `ARCHITECTURE.md` holds the data-flow diagram and the full **Core invariants** list — read it before touching membrane/transport code; this file only adds what that doesn't, the conventions and traps that are expensive to rediscover.

## Scope boundary (hard line)

- **Cloudflare Turnstile / challenge work is _compatibility only_** — stop the membrane from *breaking* a challenge a real human would solve. It is **never** a solver, token forgery, fingerprint spoofing, or detection-evasion. *Why:* anti-bot spoofing is a documented project non-goal (`ARCHITECTURE.md`), and those techniques serve bot evasion — the opposite of this product. Git history contains a deliberate "remove Cloudflare bypass" commit.
- Decomposing or editing the membrane must **preserve every fail-closed branch** (no-direct-egress, unknown-request-blocked-with-no-`fetch` fallback, capability-token stripping). Any change to an *observable* security invariant (egress, fail-closed, masking) is surfaced for explicit approval, not applied silently. *Why:* shipping a weakened boundary is breaking the product, not cleaning it.

## Membrane/protocol refactor discipline (load-bearing)

- A behavior-preserving change to membrane or protocol code must be proven by a **transient differential harness**, not a green suite: freeze the pre-change function verbatim under a new name, drive both old and new over a generated + edge corpus through the package's existing test seam (`scriptedRW` in socks5, `net.Pipe`/`pipeMux` in wsproto/zphttp), assert **0 mismatches** (return value, error string, bytes on the wire), then **delete the harness — never commit it** (`zz_*` scaffolding is correctly rejected in review). Keep a *permanent* characterization/adversarial oracle. *Why:* the `transform.go` decomposition passed the full suite but silently changed a marker; only a differential caught it. Suite-green ≠ behavior-preserved.
- Removing a complexity `//nolint` is only real if the gate actually fires on that file. Prove it **red-before**, not just green-after: drop the pre-decomposition original (nolint stripped) at the path, confirm golangci **fails** on the complexity linter, then restore the decomposed file byte-identical (md5). *Why:* a stale `.golangci.yml` header once claimed the gates were "disabled" while they were live — green-after alone would have been hollow.

## Lint / complexity gates

- Complexity gates are **live and hard**: golangci `cyclop` ≤10 / `gocognit` ≤15 / `nestif` ≤4 (`_test.go` excluded), clippy `cognitive_complexity = "deny"` @15, Biome `noExcessiveCognitiveComplexity` @15. **Decompose to satisfy them — do not add new suppressions.** *Why:* the campaign is burning these down, not accumulating them.
- Known, deliberate remaining suppressions (a burn-down tail, not free license): inline `//nolint:<linter> // TODO(complexity)` on the wasm-tagged kernel/bridge functions, and a glob override turning `noExcessiveCognitiveComplexity` **off** for `web/runtime-prelude.js` / `worker-prelude.js` / `sw.js` (the 4.4k-line membrane) plus inline `biome-ignore` in `worker-prelude.js` / `zp-core.js`. These need a differential-harness decomposition, not a quick edit.

## Build / verify traps

- **wasm-tagged files** (`//go:build js && wasm`: `cmd/wasm-kernel/main.go`, `internal/swhttp/bridge_js.go`, `internal/wsconn/conn_js.go`) are **skipped by `go test ./...` and the native golangci pass.** They are covered *only* by `GOOS=js GOARCH=wasm golangci-lint run` and `GOOS=js GOARCH=wasm go build ./cmd/wasm-kernel`. Run those after any transport/bridge change or you have verified nothing for that code. (`npm run lint:go` already runs both golangci passes.)
- Run `golangci-lint cache clean` before trusting lint results — the results cache serves stale issues from deleted worktrees (paths like `../../../../tmp/…`, "can't read file").
- Use the npm test scripts (`npm test` / `test:js` / `test:e2e` → `node scripts/test.mjs [js|e2e]`). **Do not** run `node --test test/js` — Node 24 treats the directory as a module and reports a spurious failure.
- **E2E flake:** the two heavy Puppeteer tests can mutually starve under load — one times out at the ~31.5s page deadline while the other passes, and *which* one fails migrates between runs. A migrating failure is environmental, not a regression (a real regression fails the same test deterministically); re-run, or run the e2e tests individually, before blaming a code change.

## Commits

- Conventional Commits, one concern per commit; substantive commits carry an `Op: compress|extend|correct` trailer (plus `Restores: …` for `correct`). Use the configured git identity — **no** `--author`, `Co-Authored-By`, `Signed-off-by`, or any agent trailer; do not mutate git config.
