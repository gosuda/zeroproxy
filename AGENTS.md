# PROJECT KNOWLEDGE BASE - ZeroProxy

**Generated:** 2026-06-13
**Commit:** ed6d65f
**Branch:** main

## OVERVIEW

ZeroProxy is a human-in-the-loop virtual-browsing privacy membrane: a real
person drives a real browser, and target traffic egresses only through
`Service Worker -> Go WASM kernel -> WebSocket/smux -> SOCKS5 -> uTLS`.

## STRUCTURE

```text
zeroproxy/
+-- web/                    # browser shell, service worker, runtime membrane
+-- rewriter-rs/            # Rust WASM HTML/CSS/JS/import-map rewriter
+-- cmd/wasm-kernel/        # Go js/wasm transport kernel
+-- cmd/zeroproxy-server/   # native server and WebSocket/smux relay
+-- internal/               # Go protocol, transport, policy, and adapters
+-- test/                   # JS policy tests, Puppeteer e2e, compatibility data
+-- scripts/                # build/test/corpus orchestration
`-- third_party/quickjs-ng/ # vendored upstream QuickJS-ng tree
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Browser membrane / SW routing | `web/` | Scoped rules in `web/AGENTS.md`. |
| Static rewriting pipeline | `rewriter-rs/`, `internal/htmltx/` | Rust behavior is outside `npm test`. |
| WASM kernel bridge | `cmd/wasm-kernel/`, `internal/swhttp/`, `internal/wsconn/` | Requires js/wasm build, lint, and tests. |
| Target transport path | `internal/zphttp/`, `internal/socks5/`, `internal/wsproto/`, `internal/smuxconn/` | Protocol changes need differential proof. |
| Server and relay | `cmd/zeroproxy-server/` | Serves built assets and bridges streams. |
| Compatibility fixtures | `test/fixtures/`, `test/e2e/` | Scoped rules in `test/AGENTS.md`. |
| CI/build truth | `package.json`, `scripts/build.mjs`, `scripts/test.mjs`, `.github/workflows/ci.yml` | npm scripts are canonical. |

## CODE MAP

| Symbol / Surface | Type | Location | Role |
| --- | --- | --- | --- |
| `main` | Go function | `cmd/zeroproxy-server/main.go` | Native server entrypoint. |
| `server.handlePipe` | Go method | `cmd/zeroproxy-server/main.go` | WebSocket/smux relay ingress. |
| `readSOCKS5Connect` | Go function | `cmd/zeroproxy-server/main.go` | Internal SOCKS handshake parser. |
| `main` | Go function | `cmd/wasm-kernel/main.go` | js/wasm kernel entrypoint. |
| `Kernel.ensure` | Go method | `cmd/wasm-kernel/main.go` | Lazy relay engine setup; only live Go complexity suppression. |
| `runtime-prelude-entry.mjs` | JS entry | `web/` | Vite entry for runtime membrane bundle. |
| `sw-entry.mjs` | JS entry | `web/` | Vite entry for service worker bundle. |
| `worker-prelude-entry.mjs` | JS entry | `web/` | Vite entry for worker bootstrap bundle. |
| `rewrite_*` exports | Rust/wasm | `rewriter-rs/src/lib.rs` | HTML/CSS/JS/import-map rewrite API. |

## CONVENTIONS

- Behavior-preserving membrane or protocol refactors require a transient
  differential harness, not only a green suite: freeze the old function
  verbatim under a temporary name, drive old and new through the package's
  existing seam (`scriptedRW`, `net.Pipe`, or `pipeMux`), assert 0 mismatches
  across return values, error strings, and bytes on the wire, then delete the
  harness before commit. Keep a permanent characterization or adversarial
  oracle when the behavior boundary matters.
- Complexity gates are live and hard: Go `cyclop <= 10`, `gocognit <= 15`,
  `nestif <= 4` for non-test files; Rust `clippy::cognitive_complexity` at 15;
  Biome `noExcessiveCognitiveComplexity` at 15. Decompose; do not add new
  suppressions.
- Removing a complexity suppression is only real if the pre-change original
  fails the intended gate with the suppression stripped. Prove red-before,
  restore the decomposed file byte-identical, then prove green-after.
- Check actual suppressions with `git grep`, not memory. Current deliberate
  residuals are the wasm-kernel `//nolint:cyclop`, the Biome overrides for
  `web/runtime-prelude.mjs`, `web/index.html`, and `test/**`, plus the single
  inline `biome-ignore` in `web/worker-prelude.js`.

## ANTI-PATTERNS (THIS PROJECT)

- Do not commit transient `zz_*` differential scaffolding.
- Do not trust `go test ./...` for js/wasm files or tests.
- Do not run `node --test test/js`; Node 24 treats the directory as a module.
- Do not blanket-format `web/**`; Biome formatting is intentionally disabled
  there while linting remains active.
- Do not add `//nolint`, `#[allow(clippy::cognitive_complexity)]`, or
  `biome-ignore` complexity suppressions for new code.
- Do not mutate git identity or add agent/co-author/signoff trailers.

## COMMANDS

```bash
npm run build
npm test
npm run test:js
npm run test:e2e
npm run test:wasm
npm run lint:go
npm run lint:rust
npm run lint:js
cargo test --manifest-path rewriter-rs/Cargo.toml
```

## NOTES

- Run `golangci-lint cache clean` before trusting lint output; stale cache
  entries can point at deleted worktrees.
- `npm run test:wasm` strips the environment with `env -i`; this avoids the Go
  wasm runner's bounded argv/env buffer overflow.
- The two heavy Puppeteer e2e tests can starve each other under load. A failure
  that migrates between them is usually environmental; rerun or isolate before
  blaming a regression.
- `third_party/quickjs-ng/` is vendor code. Keep ZeroProxy policy in wrappers or
  integration points unless the task explicitly updates the vendored project.
