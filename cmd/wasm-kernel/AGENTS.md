# AGENTS.md - cmd/wasm-kernel

## OVERVIEW

Go js/wasm kernel that bridges browser requests to the relay engine and
transforms document responses before delivery.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| js/wasm entrypoint | `main.go` | Build-tagged; skipped by native Go commands. |
| Native placeholder | `main_stub.go` | Keeps native package discovery sane. |
| Delivery behavior | `deliver_test.go` | Native test coverage for response delivery helpers. |
| WASM stream behavior | `wsstream_test.go` | Runs only through `npm run test:wasm`. |
| SW HTTP bridge | `../../internal/swhttp/bridge_js.go` | Same js/wasm verification lane. |
| WASM WebSocket conn | `../../internal/wsconn/conn_js.go` | Same js/wasm verification lane. |

## CONVENTIONS

- `main.go` is `//go:build js && wasm`; `go test ./...` and native
  `golangci-lint run` do not cover it.
- Verification for this directory is:
  `GOOS=js GOARCH=wasm go build ./cmd/wasm-kernel`,
  `GOOS=js GOARCH=wasm golangci-lint run --timeout=5m`, and
  `npm run test:wasm`.
- `npm run test:wasm` intentionally runs under `env -i` with a tiny preserved
  environment. Do not remove that wrapper.
- `Kernel.ensure` has the only intentional Go complexity suppression:
  `//nolint:cyclop // TODO(complexity)`. Any decomposition needs proof that the
  relay engine mutex/connection behavior is unchanged.
- Browser-facing errors must stay safe for delivery. Check `safeResponse`,
  `classifyErr`, and `statusForErr` before changing error plumbing.

## ANTI-PATTERNS

- Do not call native-only test or lint commands evidence for this directory.
- Do not add more `//nolint` complexity suppressions.
- Do not split the relay setup mutex region without a concrete differential or
  live-bridge verification plan.
- Do not assume wasm-tagged tests run unless `npm run test:wasm` was executed.
