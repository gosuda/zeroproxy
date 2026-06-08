# ZeroProxy Implementation Status

Date: 2026-06-08

This document is the implementation-status placeholder for the active
QuickJS/GoNetworkBackend migration. The detailed technical plan lives in
`PLAN.md`; this file tracks what has actually landed in the repository.

Old Service Worker/Rust-rewriter release-gate status has been intentionally
removed. Do not re-add stale status text. As implementation progresses, update
this document with completed work, verification results, known gaps, and any
intentional deviations from `PLAN.md`.

## Current Target

Planned architecture:

```text
QuickJS-NG WASM
  -> JS Web API stubs / virtual browser bridge
  -> GoNetworkBackend
     -> WorkerBackend: Dedicated Worker + wasm_exec.js + kernel.wasm
     -> ForegroundBackend: same Go WASM kernel fallback
  -> existing Go WASM network engine
  -> WebSocket/smux/SOCKS5/uTLS
```

Route policy:

- Keep the existing share URL format:
  `/zp/p/<encrypted>#k=<key>[&server=<relay>...]`.
- Do not introduce a replacement document-route namespace.
- Remove Service Worker interception from the new runtime path.
- Keep the Go WASM network engine.
- Remove Rust JS rewriter/codegen from the target-JS execution hot path.

## Status Ledger

| Area | Status | Notes |
|---|---|---|
| `PLAN.md` architecture | Planned | Current source of truth. |
| GoNetworkBackend protocol | Not started | Must be versioned, streaming, cancellable, and backend-neutral. |
| WorkerBackend | Not started | Dedicated Worker hosting existing Go WASM kernel. |
| ForegroundBackend fallback | Not started | Same backend contract as WorkerBackend. |
| `fetchRaw` response shape | Not started | Header-first, body-streamed, redirect/cache/timing aware. |
| QuickJS-NG runtime | Not started | Target JS must execute only in QuickJS. |
| QuickJS host ABI | Not started | Opaque handles, deterministic ownership, event-loop scheduling. |
| `x/net/html` sanitizer | Not started | Required before Service Worker deletion. |
| Resource blob/internal URL rewrite | Not started | Native renderer must never see raw target resource URLs. |
| Event listener compatibility | Not started | `addEventListener`, `on*`, inline handlers, propagation, options. |
| Viewport/resize/layout compatibility | Not started | Resize, media queries, observers, layout readback. |
| IndexedDB storage/cache manager | Not started | Virtual-origin partitioned durable storage and HTTP cache. |
| Web API surface comparator | Not started | Chromium vs QuickJS virtual browser surface and behavior probes. |
| Acid harness | Not started | Must map failures to Web API/sanitizer/runtime gaps. |
| Service Worker removal | Not started | Remove only after GoNetworkBackend and sanitizer path are proven. |
| Rust JS rewriter hot-path removal | Not started | Keep only parsing/resource helpers if still useful. |

## Required Verification Placeholders

Record results here as work lands:

- GoNetworkBackend protocol fixtures:
  - status: not run
  - notes:
- WorkerBackend vs ForegroundBackend differential corpus:
  - status: not run
  - notes:
- `fetchRaw` response-shape tests:
  - status: not run
  - notes:
- `x/net/html` sanitizer tests:
  - status: not run
  - notes:
- Native browser request-log e2e leak checks:
  - status: not run
  - notes:
- QuickJS host ABI tests:
  - status: not run
  - notes:
- Event listener compatibility tests:
  - status: not run
  - notes:
- Viewport/resize/layout tests:
  - status: not run
  - notes:
- IndexedDB storage/cache policy tests:
  - status: not run
  - notes:
- Web API surface comparator:
  - status: not run
  - notes:
- Acid harness:
  - status: not run
  - notes:
- `npm test`:
  - status: not run
  - notes:
- `npm run lint`:
  - status: not run
  - notes:
- `npm run test:wasm`:
  - status: not run
  - notes:

## Update Rule

Every implementation change for the QuickJS/GoNetworkBackend migration must
update this file in the same branch when it changes behavior, status, scope,
verification, or known gaps. Keep entries concise and repository-backed.
