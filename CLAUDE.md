# ZeroProxy: Agent Onboarding

ZeroProxy is a security proxy that rewrites target JavaScript through an OXC AST pipeline to provide a virtual `location` and `window` environment. Every execution path enforces a strict "No-Escape Jail" containment model.

## Mandatory Pre-Work Checks

Review the two reference documents below before modifying any code to understand existing traps and containment gates.

### 1. Trap Notebook (`.ai/trap-notebook/`)

[`.ai/trap-notebook/`](.ai/trap-notebook/README.md) records subtle browser behaviors, AST rewriter edge cases, and transport pitfalls discovered across the codebase.

Before starting work (especially in `web/sw.js`, `web/membrane/`, `crates/zp-htmltx`, or `crates/zp-rewriter`), scan the index:

```bash
head -40 .ai/trap-notebook/INDEX.md
grep -i "<keyword>" .ai/trap-notebook/INDEX.md
```

Each line in [`.ai/trap-notebook/INDEX.md`](.ai/trap-notebook/INDEX.md) points to an anchor in a category file. Do not read the entire index; open only the matching category entry.

Immediately after fixing a newly discovered trap, add an anchored entry to `.ai/trap-notebook/<category>.md` and a single summary line to `INDEX.md`. Do not write multi-line descriptions inside `INDEX.md` (`test/js/static-policy.test.js` enforces a 160-character line limit and verifies every link target). Full formatting rules live in [`.ai/trap-notebook/README.md`](.ai/trap-notebook/README.md).

### 2. Containment and Compatibility Verification Status

[`PHASE2_STATUS.md`](PHASE2_STATUS.md) tracks the verification baseline and gates `A1` through `E5`, along with the code paths and automated tests that prove each gate holds. Check and update the corresponding gate evidence whenever you touch a security boundary.

## Scope: Containment and Compatibility (Not Concealment)

A proxy transfers and transforms content safely. ZeroProxy enforces **containment** and **compatibility**; hiding the existence of the proxy from target JavaScript (**concealment**) is not a project goal.

- **Containment (Primary Goal)**:
  1. Target code never obtains native networking (every request routes through the Service Worker and relay).
  2. Target code never obtains the real `window`, `Location`, or an uncontained realm.
  3. Target code never reaches another target origin's cookies, storage, DOM, frames, or the proxy control surface.
  4. Unrewritten code never executes (rewrite failures fail closed).
- **Compatibility (Primary Goal)**: Websites that load and function in a native browser also load and function through ZeroProxy.
- **Concealment (Non-Goal)**: Hiding error stack strings, property descriptor shapes, canvas or audio fingerprints, readable proxy origin strings or share URLs, or bypassing automated bot-scoring heuristics is out of scope. Existing masking hooks remain in place, but do not expand them.
- **Human-Interactive Compatibility**: If a human user passes an interactive check (such as a CAPTCHA or verification challenge) in a native browser but fails in ZeroProxy, treat it as an in-scope compatibility defect. Diagnose where ZeroProxy diverges from standard browser specifications and fix the underlying behavior rather than spoofing values. Test one hypothesis at a time against measured browser behavior.
- **Work Selection Criterion**: Before starting a change, verify whether it protects one of the four containment rules above or fixes compatibility for a broken site. If it does neither, do not make the change.

## Architecture Summary

ZeroProxy combines a Rust WebAssembly transformation and transport stack, a JavaScript runtime membrane, and a Go relay server.

| Component | Responsibility |
| :--- | :--- |
| [`crates/zp-engine`](crates/zp-engine) | Rust facade crate unifying script rewriting, streaming HTML transformation, CSS rewriting, and source map composition. |
| [`crates/zp-bundle`](crates/zp-bundle) | Service Worker WebAssembly bundle exposing `zp-engine` and shared policy functions. |
| [`crates/zp-kernel-bundle`](crates/zp-kernel-bundle) | Lazily loaded Rust WebAssembly transport kernel (`yamux`, SOCKS5, `rustls`, HTTP/1.1, HTTP/2, and WebSockets). |
| [`crates/zp-rewriter`](crates/zp-rewriter) | OXC AST JavaScript rewriter. |
| [`crates/zp-htmltx`](crates/zp-htmltx), [`crates/zp-css`](crates/zp-css) | Streaming `lol_html` HTML transformer and SWC CSS URL rewriter. |
| [`crates/zp-shared`](crates/zp-shared), [`crates/zp-transport-codec`](crates/zp-transport-codec) | CSP builders, share URL encryption, error codes, and SOCKS5/HTTP/1.1 wire codecs. |
| [`crates/zp-page-bundle`](crates/zp-page-bundle), [`crates/zp-page-rt`](crates/zp-page-rt) | Slim page-realm script rewriter bundle and synchronous raw-WASM URL policy runtime. |
| [`web/sw.js`](web/sw.js) | Service Worker entry point handling request classification, runtime APIs, and transport kernel dispatch. |
| [`web/membrane/`](web/membrane), [`web/runtime-prelude.js`](web/runtime-prelude.js) | Page bootstrap prelude and virtual browser membrane (`__zp_get`, `__zp_set`, storage and cookie facades). |
| [`cmd/zeroproxy-server/main.go`](cmd/zeroproxy-server/main.go), [`internal/httphost`](internal/httphost) | Go HTTP server, WebSocket relay bridge, and optional WebTransport and TURN gateways. |

## Build and Run

> [!IMPORTANT]
> Always pass the compiled asset directory `-web dist/web` when starting the server. Passing the source directory (`-web web`) causes HTTP `503` errors because generated `wasm-bindgen` artifacts only exist under `dist/web`. See [`.ai/trap-notebook/build-deploy.md`](.ai/trap-notebook/build-deploy.md) for environment details.

1. Run the full build for Rust WASM bundles, JavaScript assets, and the Go server binary.
2. Start the server in local direct-dial test mode (`-socks internal`).

```bash
npm run build
./dist/zeroproxy-server \
  -web "$(realpath dist/web)" \
  -addr 127.0.0.1:18080 \
  -socks internal
```

## Verification

Run the automated unit, policy, and browser end-to-end test suites with these commands:

```bash
npm run test:js
cargo test --workspace
go test ./...
npm run test:e2e
```

Use `taskweaver` for interactive real-site verification:

```bash
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/"
taskweaver fill-form -i zp --selector "input" --value "<target_url>"
taskweaver click -i zp --text "Open"
taskweaver screenshot -i zp --output artifacts/site-check.png
```

**`taskweaver` Instance Policy (Mandatory)**:
- **Always use `--id zp` exclusively.** Never create additional instance IDs (`zp2`, `zp3`, `zpb`).
- Check `taskweaver list` at the start of a task to see whether `id: "zp"` is already running:
  - If present, reuse the existing `zp` instance.
  - If absent, start it with `taskweaver start --id zp --width 1200 --height 800`.
- Multiple sessions share this browser instance; spawning extra IDs duplicates browser processes and exhausts host memory.

Target sites and evaluation criteria for the real-site compatibility matrix live in [`.ai/trap-notebook/real-site-compat.md`](.ai/trap-notebook/real-site-compat.md).

## Code Style

- Write all code, identifiers, comments, log/error strings, test names, assertion messages, and documentation in English only.
- Focus comments on **why** a constraint or design choice exists; let clear identifiers express **what** the code does.
- Audit existing structures before introducing new abstractions to avoid premature indirection.
- Cross-check any change that touches containment boundaries against the E1 escape matrix in [`test/e2e/proxy.test.js`](test/e2e/proxy.test.js).

## Commit and Pull Request Rules

- **No AI Co-Author Trailers**: Never append `Co-Authored-By:` trailers to commit messages or "Generated with" footers to pull request descriptions.
- This policy is enforced by `"attribution": {"commit": "", "pr": ""}` in [`.claude/settings.json`](.claude/settings.json). If an attribution trailer appears, inspect local configuration overrides (such as `.claude/settings.local.json`) before committing.
- Do not `force-push` the `main` branch or rewrite published Git history to strip trailers from older commits.
