# ZeroProxy

ZeroProxy is a human-in-the-loop virtual-browsing privacy membrane. A real user drives a real browser UI, while target-page code and target network traffic are contained behind a controlled runtime and transport path.

## Current architecture

The active migration target is no longer the legacy Service Worker interception path. The current runtime is:

```text
Host shell
  -> QuickJS-NG WASM realm
  -> virtual DOM / Web API facades / host WebIDL bridge
  -> GoNetworkBackend
     -> Dedicated Worker Go WASM kernel, with foreground fallback
  -> existing WebSocket/smux/SOCKS5/uTLS transport
```

The share URL format is unchanged:

```text
/zp/p/<encrypted>#k=<key>[&server=<relay>...]
```

## Current status

See [`PLAN.md`](PLAN.md) for the architecture contract and [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for the current status ledger.

As of the current checked-in Web API report:

- tracked Web API entries: `979`
- implemented entries: `219`
- partial entries: `726`
- blocked by policy: `29`
- out of scope: `5`
- hidden missing entries: `0`
- browser globals still absent after install: `2` (`Temporal`, `WebAssembly`; out of scope)
- descriptor-shape audited entries: `930`
- remaining shape mismatches: `416`
- implemented entries with shape mismatches: `0`

Surface presence is mostly in place. Browser behavior/prototype/descriptor parity is still incomplete and is the main remaining workstream.

## What has landed

- QuickJS-NG runtime and host ABI:
  - `third_party/quickjs-ng`
  - `quickjs-runtime/bridge.c`
  - `web/runtime/quickjs/engine.mjs`
- Deterministic virtual event loop:
  - tasks, timers, microtasks, promise jobs, console capture, navigation reset/preservation
  - `requestIdleCallback`, `scheduler.postTask`, `TaskController` basics
- QuickJS virtual browser layer:
  - virtual DOM, event dispatch, viewport/layout geometry, media queries, observers, animation/timeline basics, performance facades
- GoNetworkBackend:
  - worker backend using the existing Go WASM kernel
  - foreground fallback using the same backend contract
  - versioned protocol records for fetch, WebSocket, storage/cache/cookie, health, shutdown, cancellation, and errors
- Resource/document loading:
  - Go HTML sanitizer using `golang.org/x/net/html`
  - CSS/resource URL rewrite
  - target script evaluation through QuickJS
- Web API facades and host WebIDL bridge:
  - network APIs, storage APIs, Blob/File/FormData/FileReader, URL/URLSearchParams, DOMParser/XMLSerializer, CSSOM basics, streams, crypto, trusted types, media/device policy facades, and many long-tail constructors
- Legacy active path removal:
  - no active Service Worker registration
  - no active `/zp/api/fetch`, `/zp/api/script`, or `/zp/api/worker-script` generation
  - Rust target-JS rewriter removed from the active browser hot path

## Next maintainer tasks

Work top-down from the current Web API gap report:

```sh
node scripts/snapshot-quickjs-surface.mjs \
  && node scripts/compare-webapi-surface.mjs \
  && node scripts/probe-webapi-behavior.mjs
```

Then inspect:

- `test/fixtures/webapi/webapi-gap-report.json`
- `test/fixtures/webapi/webapi-gap-report.md`
- `IMPLEMENTATION_STATUS.md`

Recommended order:

1. **Continue Web API parity cleanup.**
   - Reduce the remaining `416` descriptor/prototype mismatches.
   - Keep `implementedShapeMismatchEntries` at `0`.
   - Prefer host WebIDL bridging for pure browser algorithms/reflection.
   - Keep direct QuickJS implementations only for virtual DOM identity, storage, navigation, network, workers, policy, and target-visible state.

2. **Attack the large DOM/element groups.**
   - `Document`, `Node`, `Element`, `EventTarget`, `clientInformation`.
   - HTML element long-tail prototypes (`HTMLInputElement`, forms, anchors, media, script/link/style/table classes).
   - SVG element/value/filter/text classes.

3. **Finish behavior edge parity.**
   - parser/tree-construction, XML/namespace behavior
   - Range/Traversal/Selection mutation edge cases
   - MutationRecord payload details
   - form validation/submission algorithms
   - CSS cascade/layout/computed style
   - FileReader/FormData/Blob URL edge behavior
   - IndexedDB cursor/index/transaction semantics
   - Cache eviction/storage/cookie/history traversal details

4. **Run site-driven failure collection again.**
   - Naver
   - Cloudflare-protected pages
   - Google
   - Google Maps
   - Record first-failing surface, console/page errors, request failures, iframe/script rewrite failures, and Web API shape gaps before implementing fixes.

5. **Keep the status ledger short.**
   - Update `IMPLEMENTATION_STATUS.md` with only current metrics, landed changes, verification, and remaining blockers.
   - Do not paste large historical transcripts into it.

## Development
Requirements:

- Go version from `go.mod`
- Rust stable with `wasm32-unknown-unknown`
- Node.js 24.x and npm
- Emscripten `emcc` for building QuickJS-NG into browser assets
- checked-out submodules, especially `third_party/quickjs-ng`

CI installs Emscripten and checks out submodules automatically; local clones need:

```sh
git submodule update --init --recursive
```


Install dependencies and build:

```sh
npm ci
npm run build
```

Run the server locally:

```sh
./dist/zeroproxy-server -addr :8080 -socks internal
```

Open:

```text
http://proxy.localhost:8080/
```

`-socks internal` is for local development and CI. It is not an anonymity mode. For Tor-backed experiments, point `-socks` at a Tor SOCKS5 listener:

```sh
./dist/zeroproxy-server -addr :8080 -socks 127.0.0.1:9050
```

## Useful verification loops

Focused loops:

```sh
npm run build:webapi-core
npm run test:webapi-surface
npm run test:webapi-behavior
npm run test:quickjs
npm run test:acid
npm run test:network-worker
npm run lint:js
```

Broader local gate:

```sh
npm test
npm run test:wasm
npm run lint:go
npm run lint:rust
npm run lint:js
cargo test --manifest-path rewriter-rs/Cargo.toml
```

Use the npm scripts instead of invoking `node --test test/js` directly.

## Repository map

| Path | Purpose |
|---|---|
| `web/host-shell-entry.mjs` | Host shell entry for the QuickJS virtual-browser path. |
| `web/runtime/quickjs/` | QuickJS runtime wrapper and deterministic event loop. |
| `web/runtime/dom/virtual-dom.mjs` | QuickJS virtual DOM, events, layout, observers, animations, and performance facades. |
| `web/runtime/webapi/` | Web API core, generated realm bundle, WebIDL facade modules, storage manager, host bridge. |
| `web/runtime/network/` | GoNetworkBackend protocol/client and virtual network API shims. |
| `web/runtime/resources/` | Target document/resource loader and URL virtualization. |
| `web/network-worker.js` | Dedicated Worker backend for the Go WASM kernel. |
| `quickjs-runtime/` | C host ABI compiled with QuickJS-NG. |
| `cmd/wasm-kernel/` | Go WASM transport kernel. |
| `cmd/zeroproxy-server/` | Static asset server and WebSocket/smux relay. |
| `internal/htmlsanitize/` | Go HTML sanitizer for target documents. |
| `internal/cssrewrite/` | CSS URL rewrite helper. |
| `internal/zphttp/`, `internal/socks5/`, `internal/wsproto/` | Target transport path. |
| `rewriter-rs/` | Rust helper crate retained outside the active browser target-JS hot path. |
| `scripts/` | Build, surface snapshot, comparator, behavior probe, acid, and corpus tooling. |
| `test/fixtures/webapi/` | Host/QuickJS surface snapshots and Web API gap reports. |
| `test/js/` | Runtime, Web API, policy, compatibility, and network tests. |
| `test/e2e/` | Representative browser compatibility tests. |
